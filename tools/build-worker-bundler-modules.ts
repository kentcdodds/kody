import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, type Plugin } from 'esbuild'
import { isExecutedDirectly } from './node-runtime.ts'

/**
 * Pre-bundles `@cloudflare/worker-bundler` (and its `/typescript` entry) into
 * standalone ES modules under `packages/worker/src/generated/`.
 *
 * Why: wrangler inlines every dynamic `import()` into the single main worker
 * module, so the ~3.6 MB runtime bundler/TypeScript compiler was parsed and
 * evaluated on every isolate cold start even though only repo checks use it.
 * With `find_additional_modules` enabled in `wrangler.jsonc`, these generated
 * `.mjs` files upload as separate external modules that only load when the
 * repo-check paths actually import them.
 *
 * The output is deterministic for a given installed package version, so a
 * stamp file makes re-runs a no-op (important: this runs in front of every
 * wrangler dev/build/deploy and once per vitest run).
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const generatedDir = path.join(repoRoot, 'packages/worker/src/generated')
const stampPath = path.join(generatedDir, 'worker-bundler.stamp.json')

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

/** Idempotent: skips the esbuild work when the stamp is already current. */
export async function ensureWorkerBundlerModules() {
	const bundlerPackageDir = resolveWorkerBundlerDistDir()
	const stampContent = await buildStampContent(bundlerPackageDir)
	if ((await readStamp()) === stampContent) return

	await mkdir(generatedDir, { recursive: true })
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
		outdir: generatedDir,
		outExtension: { '.js': '.mjs' },
		plugins: [externalsPlugin],
		logLevel: 'silent',
	})
	await copyFile(
		path.join(bundlerPackageDir, 'dist/esbuild.wasm'),
		path.join(generatedDir, 'esbuild.wasm'),
	)
	await writeFile(stampPath, stampContent)
}

if (isExecutedDirectly(import.meta.url)) {
	await ensureWorkerBundlerModules()
}
