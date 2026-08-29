import { createHash } from 'node:crypto'
import {
	copyFile,
	link,
	mkdir,
	open,
	readFile,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, type Plugin } from 'esbuild'
import { isExecutedDirectly } from './node-runtime.ts'

/**
 * Pre-bundles `@cloudflare/worker-bundler` (and its `/typescript` entry) into
 * standalone ES modules under `packages/worker/.generated/`.
 *
 * Why: wrangler inlines every dynamic `import()` into the single main worker
 * module, so the ~3.6 MB runtime bundler/TypeScript compiler was parsed and
 * evaluated on every isolate cold start even though only repo checks use it.
 * With `find_additional_modules` enabled in `wrangler.jsonc`, these generated
 * `.mjs` files upload as separate external modules that only load when the
 * repo-check paths actually import them.
 *
 * Wrangler discovers additional ES modules by walking the entry directory
 * (`packages/worker/src`) and file-watches every discovered module. A separate
 * CompiledWasm `esbuild.wasm` under `src/` retriggers that watcher when
 * wrangler re-attaches the wasm (Friction #1789). The files live in
 * `packages/worker/.generated/` and are hardlinked under
 * `src/node_modules/.kody-generated/` so the walk finds them. Wasm is inlined
 * into `esbuild-wasm.mjs` (an ES module) instead of uploaded as CompiledWasm,
 * so reload does not re-copy a 17 MB wasm file. The `node_modules/` prefix
 * also keeps the additional-module *directory* watcher off this tree.
 *
 * The output is deterministic for a given installed package version, so a
 * stamp file makes re-runs a no-op (important: this runs in front of every
 * wrangler dev/build/deploy and once per vitest run).
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
export const workerBundlerGeneratedDir = path.join(
	repoRoot,
	'packages/worker/.generated',
)
export const workerBundlerWranglerDir = path.join(
	repoRoot,
	'packages/worker/src/node_modules/.kody-generated',
)
const leftoverSrcGeneratedDir = path.join(
	repoRoot,
	'packages/worker/src/generated',
)
export const leftoverSrcGeneratedBundlerNames = [
	'worker-bundler.mjs',
	'worker-bundler-typescript.mjs',
	'esbuild.wasm',
	'worker-bundler.stamp.json',
] as const
const generatedArtifactNames = [
	'worker-bundler.mjs',
	'worker-bundler-typescript.mjs',
	'esbuild-wasm.mjs',
] as const
const leftoverWranglerVisibleNames = [
	...generatedArtifactNames,
	'esbuild.wasm',
] as const
const stampPath = path.join(
	workerBundlerGeneratedDir,
	'worker-bundler.stamp.json',
)

const nodeBuiltins = new Set([
	'assert',
	'buffer',
	'child_process',
	'crypto',
	'events',
	'fs',
	'http',
	'https',
	'inspector',
	'module',
	'net',
	'os',
	'path',
	'perf_hooks',
	'process',
	'stream',
	'tls',
	'url',
	'util',
	'worker_threads',
	'zlib',
])

/**
 * Keeps `./esbuild.wasm` imports external verbatim (wrangler uploads the wasm
 * as a sibling CompiledWasm module) and normalizes Node builtins to their
 * `node:`-prefixed form so `nodejs_compat` resolves them at runtime.
 */
const externalsPlugin: Plugin = {
	name: 'worker-bundler-externals',
	setup(pluginBuild) {
		pluginBuild.onResolve({ filter: /\.wasm$/ }, (args) => ({
			path: args.path,
			external: true,
		}))
		pluginBuild.onResolve({ filter: /^node:/ }, (args) => ({
			path: args.path,
			external: true,
		}))
		pluginBuild.onResolve({ filter: /^[a-z_]+$/ }, (args) => {
			if (!nodeBuiltins.has(args.path)) return null
			return { path: `node:${args.path}`, external: true }
		})
	},
}

async function readStamp(): Promise<string | null> {
	try {
		return await readFile(stampPath, 'utf8')
	} catch {
		return null
	}
}

function resolveWorkerBundlerDistDir() {
	// Resolved by direct path: the package is ESM-only so CJS
	// `require.resolve` cannot see its exports, and `import.meta.resolve` is
	// unsupported inside vitest's module runner (this runs as global setup).
	return path.join(repoRoot, 'node_modules', '@cloudflare', 'worker-bundler')
}

async function buildStampContent(bundlerPackageDir: string) {
	const bundlerPackageJson = await readFile(
		path.join(bundlerPackageDir, 'package.json'),
		'utf8',
	)
	const generatorSource = await readFile(fileURLToPath(import.meta.url), 'utf8')
	const esbuildVersion = (
		JSON.parse(
			await readFile(
				path.join(repoRoot, 'node_modules', 'esbuild', 'package.json'),
				'utf8',
			),
		) as { version: string }
	).version
	const hash = createHash('sha256')
		.update(bundlerPackageJson)
		.update(esbuildVersion)
		.update(generatorSource)
		.digest('hex')
	return JSON.stringify({ hash }, null, '\t')
}

async function pathExists(filePath: string) {
	try {
		await stat(filePath)
		return true
	} catch {
		return false
	}
}

async function wranglerVisibleModulesExist() {
	const results = await Promise.all(
		generatedArtifactNames.map((name) =>
			pathExists(path.join(workerBundlerWranglerDir, name)),
		),
	)
	return results.every(Boolean)
}

export async function removeLeftoverSrcGeneratedBundlerArtifacts() {
	await Promise.all(
		leftoverSrcGeneratedBundlerNames.map((name) =>
			rm(path.join(leftoverSrcGeneratedDir, name), { force: true }),
		),
	)
}

async function writeInlinedWasmModule(wasmPath: string, outPath: string) {
	const base64 = (await readFile(wasmPath)).toString('base64')
	await writeFile(
		outPath,
		`const bytes = Uint8Array.from(atob("${base64}"), (char) => char.charCodeAt(0))\nexport default await WebAssembly.compile(bytes)\n`,
	)
}

async function rewriteWasmImport(bundlerModulePath: string) {
	const source = await readFile(bundlerModulePath, 'utf8')
	const rewritten = source.replaceAll(
		'import("./esbuild.wasm")',
		'import("./esbuild-wasm.mjs")',
	)
	if (rewritten === source) {
		throw new Error(
			`${path.basename(bundlerModulePath)} did not contain import("./esbuild.wasm")`,
		)
	}
	await writeFile(bundlerModulePath, rewritten)
}

async function materializeWranglerVisibleModules() {
	await mkdir(workerBundlerWranglerDir, { recursive: true })
	await Promise.all(
		leftoverWranglerVisibleNames.map((name) =>
			rm(path.join(workerBundlerWranglerDir, name), { force: true }),
		),
	)
	for (const name of generatedArtifactNames) {
		const from = path.join(workerBundlerGeneratedDir, name)
		const to = path.join(workerBundlerWranglerDir, name)
		try {
			await link(from, to)
		} catch {
			await copyFile(from, to)
		}
	}
}

/** Idempotent: skips the esbuild work when the stamp is already current. */
export async function ensureWorkerBundlerModules() {
	const bundlerPackageDir = resolveWorkerBundlerDistDir()
	const stampContent = await buildStampContent(bundlerPackageDir)
	await removeLeftoverSrcGeneratedBundlerArtifacts()
	if (
		(await readStamp()) === stampContent &&
		(await wranglerVisibleModulesExist())
	) {
		return
	}

	await mkdir(workerBundlerGeneratedDir, { recursive: true })
	await build({
		entryPoints: {
			'worker-bundler': path.join(bundlerPackageDir, 'dist/index.js'),
			'worker-bundler-typescript': path.join(
				bundlerPackageDir,
				'dist/typescript.js',
			),
		},
		bundle: true,
		format: 'esm',
		platform: 'browser',
		target: 'es2022',
		minify: true,
		outdir: workerBundlerGeneratedDir,
		outExtension: { '.js': '.mjs' },
		plugins: [externalsPlugin],
		logLevel: 'silent',
	})
	const wasmPath = path.join(bundlerPackageDir, 'dist/esbuild.wasm')
	await copyFile(wasmPath, path.join(workerBundlerGeneratedDir, 'esbuild.wasm'))
	await writeInlinedWasmModule(
		wasmPath,
		path.join(workerBundlerGeneratedDir, 'esbuild-wasm.mjs'),
	)
	await rewriteWasmImport(
		path.join(workerBundlerGeneratedDir, 'worker-bundler.mjs'),
	)
	await writeFile(stampPath, stampContent)
	await materializeWranglerVisibleModules()
	await fsyncGeneratedDir()
}

async function fsyncGeneratedDir() {
	const handle = await open(workerBundlerGeneratedDir, 'r')
	try {
		await handle.sync()
	} finally {
		await handle.close()
	}
}

if (isExecutedDirectly(import.meta.url)) {
	await ensureWorkerBundlerModules()
}
