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
import {
	packageAppRemixSubpaths,
	packageAppRemixUiSubpaths,
	remixPackageName,
	remixUiPackageName,
} from '#worker/package-runtime/package-app-remix-subpaths.ts'
import { isExecutedDirectly } from './node-runtime.ts'

/**
 * Pre-bundles `@cloudflare/worker-bundler` (and its `/typescript` entry),
 * `@cloudflare/workers-oauth-provider`, `isomorphic-git` (+ web HTTP), and the
 * platform-supplied `remix` package for package apps into standalone ES
 * modules under `packages/worker/.generated/`.
 *
 * Why: wrangler inlines every dynamic `import()` into the single main worker
 * module, so the ~3.6 MB runtime bundler/TypeScript compiler was parsed and
 * evaluated on every isolate cold start even though only repo checks use it.
 * With `find_additional_modules` enabled in `wrangler.jsonc`, these generated
 * `.mjs` files upload as separate external modules that only load when the
 * repo-check paths actually import them. The rules name each file, so a stray
 * sibling under `node_modules/.kody-generated/` is not uploaded (Friction
 * #2504). The OAuth provider rides the same lane: origin's `fetch` wrapper
 * imports it statically, but
 * `#worker/oauth-helpers.ts` needs it only when `OAUTH_PROVIDER` is absent
 * (scheduled purge lane, the `MCP` Durable Object on kody-platform), and the
 * platform/runtime startup entries must not carry it. isomorphic-git is the
 * same story for bytes: a memoized `import('isomorphic-git')` still lands in
 * the main entry (~160 KB minified); the generated module keeps those bytes
 * off the startup graph until a git call runs.
 *
 * Wrangler discovers additional ES modules by walking the entry directory
 * (`packages/worker/src`) and file-watches every discovered module. Overlay-FS
 * create events on those files retrigger `wrangler dev` (Friction #1789).
 * Artifacts live in `packages/worker/.generated/` and are hardlinked under
 * `src/node_modules/.kody-generated/` so the walk finds them, the directory
 * watcher skips `node_modules`, and `tools/wrangler-filter-kody-generated-watch.ts`
 * clears that collector's esbuild `watchFiles` / `watchDirs`. workerd still
 * requires CompiledWasm for `esbuild.wasm` (`WebAssembly.compile` is
 * disallowed).
 *
 * `package-app-remix.mjs` is different in kind: it is not code the Worker
 * runs but a file set the Worker hands to the runtime bundler. Package apps
 * import `remix/<subpath>` and the platform, not npm, supplies Remix — the
 * same `remix` version the origin UI ships, so Kody's Remix conventions
 * carry over to hosted mini-apps without a 48-package npm install per
 * publish. `@remix-run/ui` primitives vendor the same way for the same
 * reason: an npm-installed copy would drag in a second
 * `@remix-run/component` runtime. Every Workers-safe subpath of both
 * packages is bundled once with esbuild code splitting so `remix/component`,
 * `remix/component/server`, and `@remix-run/ui/<primitive>` share a single
 * component runtime instance, and the result is serialized as
 * `{ "remix/package.json": …, "remix/dist/router.js": …,
 * "@remix-run/ui/package.json": …, "@remix-run/ui/dist/…": …,
 * "remix/dist/chunks/…": … }` that
 * `#worker/package-runtime/package-app-remix.ts` mounts under
 * `node_modules/` in the bundler's virtual file system.
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
	'esbuild-wasm.mjs',
	'worker-bundler.stamp.json',
] as const
export const packageAppRemixModuleName = 'package-app-remix.mjs'
export const isomorphicGitModuleName = 'isomorphic-git.mjs'
const isomorphicGitAdditionalEntryPath = path.join(
	repoRoot,
	'tools',
	'isomorphic-git-additional-entry.ts',
)
const generatedArtifactNames = [
	'worker-bundler.mjs',
	'worker-bundler-typescript.mjs',
	'oauth-provider.mjs',
	isomorphicGitModuleName,
	packageAppRemixModuleName,
	'esbuild.wasm',
] as const
const leftoverWranglerVisibleNames = [
	...generatedArtifactNames,
	'esbuild-wasm.mjs',
] as const
const stampPath = path.join(
	workerBundlerGeneratedDir,
	'worker-bundler.stamp.json',
)

const nodeBuiltins = new Set([
	'assert',
	'async_hooks',
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
 * as a sibling CompiledWasm module), leaves `cloudflare:*` runtime modules to
 * workerd, and normalizes Node builtins to their `node:`-prefixed form so
 * `nodejs_compat` resolves them at runtime.
 */
const externalsPlugin: Plugin = {
	name: 'worker-bundler-externals',
	setup(pluginBuild) {
		pluginBuild.onResolve({ filter: /\.wasm$/ }, (args) => ({
			path: args.path,
			external: true,
		}))
		pluginBuild.onResolve({ filter: /^cloudflare:/ }, (args) => ({
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

function resolveOAuthProviderPackageDir() {
	return path.join(
		repoRoot,
		'node_modules',
		'@cloudflare',
		'workers-oauth-provider',
	)
}

function resolveRemixPackageDir() {
	return path.join(repoRoot, 'node_modules', remixPackageName)
}

function resolveRemixUiPackageDir() {
	return path.join(repoRoot, 'node_modules', ...remixUiPackageName.split('/'))
}

function resolveIsomorphicGitPackageDir() {
	return path.join(repoRoot, 'node_modules', 'isomorphic-git')
}

async function buildStampContent(
	bundlerPackageDir: string,
	oauthProviderPackageDir: string,
	remixPackageDir: string,
	remixUiPackageDir: string,
	isomorphicGitPackageDir: string,
) {
	const bundlerPackageJson = await readFile(
		path.join(bundlerPackageDir, 'package.json'),
		'utf8',
	)
	const oauthProviderPackageJson = await readFile(
		path.join(oauthProviderPackageDir, 'package.json'),
		'utf8',
	)
	// The `remix` meta-package pins its `@remix-run/*` dependencies by range,
	// so the installed lockfile decides which bytes land in the vendored set;
	// stamp the lockfile too so a `npm update` of those packages regenerates.
	const remixPackageJson = await readFile(
		path.join(remixPackageDir, 'package.json'),
		'utf8',
	)
	const remixUiPackageJson = await readFile(
		path.join(remixUiPackageDir, 'package.json'),
		'utf8',
	)
	const isomorphicGitPackageJson = await readFile(
		path.join(isomorphicGitPackageDir, 'package.json'),
		'utf8',
	)
	const isomorphicGitEntrySource = await readFile(
		isomorphicGitAdditionalEntryPath,
		'utf8',
	)
	const lockfile = await readFile(
		path.join(repoRoot, 'package-lock.json'),
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
		.update(oauthProviderPackageJson)
		.update(remixPackageJson)
		.update(remixUiPackageJson)
		.update(isomorphicGitPackageJson)
		.update(isomorphicGitEntrySource)
		.update(packageAppRemixSubpaths.join('\n'))
		.update(packageAppRemixUiSubpaths.join('\n'))
		.update(lockfile)
		.update(esbuildVersion)
		.update(generatorSource)
		.digest('hex')
	return JSON.stringify({ hash }, null, '\t')
}

type RemixExportTarget = string | { default?: string; types?: string }

/**
 * Bundles the Workers-safe `remix/<subpath>` entries and the
 * `@remix-run/ui/<primitive>` entries into one code-split ESM file set and
 * serializes it as the module `package-app-remix.mjs` exports:
 * `remixVersion`, `remixUiVersion`, plus `files`, keyed relative to
 * `node_modules/` (so `remix/dist/…` and `@remix-run/ui/dist/…`).
 */
async function buildPackageAppRemixModule(
	remixPackageDir: string,
	remixUiPackageDir: string,
) {
	const remixPackage = JSON.parse(
		await readFile(path.join(remixPackageDir, 'package.json'), 'utf8'),
	) as { version: string; exports: Record<string, RemixExportTarget> }
	const remixUiPackage = JSON.parse(
		await readFile(path.join(remixUiPackageDir, 'package.json'), 'utf8'),
	) as { version: string; exports: Record<string, RemixExportTarget> }
	const entryPoints: Record<string, string> = {}
	const vendoredRemixExports: Record<string, string> = {
		'./package.json': './package.json',
	}
	for (const subpath of packageAppRemixSubpaths) {
		const target = remixPackage.exports[`./${subpath}`]
		const targetFile =
			typeof target === 'string' ? target : (target?.default ?? null)
		if (!targetFile) {
			throw new Error(
				`remix@${remixPackage.version} does not export "./${subpath}"; update packageAppRemixSubpaths.`,
			)
		}
		entryPoints[`${remixPackageName}/dist/${subpath}`] = path.join(
			remixPackageDir,
			targetFile,
		)
		vendoredRemixExports[`./${subpath}`] = `./dist/${subpath}.js`
	}
	const vendoredRemixUiExports: Record<string, string> = {
		'./package.json': './package.json',
	}
	for (const subpath of packageAppRemixUiSubpaths) {
		const target = remixUiPackage.exports[`./${subpath}`]
		const targetFile =
			typeof target === 'string' ? target : (target?.default ?? null)
		if (!targetFile) {
			throw new Error(
				`@remix-run/ui@${remixUiPackage.version} does not export "./${subpath}"; update packageAppRemixUiSubpaths.`,
			)
		}
		entryPoints[`${remixUiPackageName}/dist/${subpath}`] = path.join(
			remixUiPackageDir,
			targetFile,
		)
		vendoredRemixUiExports[`./${subpath}`] = `./dist/${subpath}.js`
	}
	// `platform: 'neutral'` keeps esbuild from injecting Node or browser
	// shims; the same output feeds the Worker bundle and the browser bundle.
	// Node builtins stay external in `node:` form: the package-app isolate
	// runs with `nodejs_compat`, and the browser bundle check rejects any
	// subpath that still needs one (`middleware/async-context`).
	// One outdir over both packages with `remix/dist/chunks/` holds the shared
	// code: `@remix-run/ui` entries import the same `@remix-run/component`
	// runtime chunk as `remix/component` instead of inlining a second copy.
	const bundleOutdir = path.join(repoRoot, 'node_modules')
	const result = await build({
		entryPoints,
		bundle: true,
		splitting: true,
		format: 'esm',
		platform: 'neutral',
		mainFields: ['module', 'main'],
		conditions: ['workerd', 'worker', 'browser', 'import', 'default'],
		target: 'es2022',
		minify: true,
		write: false,
		outdir: bundleOutdir,
		chunkNames: 'remix/dist/chunks/[name]-[hash]',
		plugins: [externalsPlugin],
		logLevel: 'silent',
	})
	const files: Record<string, string> = {
		'remix/package.json': JSON.stringify(
			{
				name: remixPackageName,
				version: remixPackage.version,
				type: 'module',
				exports: vendoredRemixExports,
			},
			null,
			'\t',
		),
		'@remix-run/ui/package.json': JSON.stringify(
			{
				name: remixUiPackageName,
				version: remixUiPackage.version,
				type: 'module',
				exports: vendoredRemixUiExports,
			},
			null,
			'\t',
		),
	}
	for (const output of result.outputFiles) {
		const relative = path
			.relative(bundleOutdir, output.path)
			.replaceAll(path.sep, '/')
		if (relative.startsWith('..')) {
			throw new Error(
				`remix prebuild emitted "${output.path}" outside the node_modules directory.`,
			)
		}
		files[relative] = output.text
	}
	const serialized = [
		'// Generated by tools/build-worker-bundler-modules.ts; do not edit.',
		`export const remixVersion = ${JSON.stringify(remixPackage.version)};`,
		`export const remixUiVersion = ${JSON.stringify(remixUiPackage.version)};`,
		`export const files = ${JSON.stringify(files)};`,
		'',
	].join('\n')
	await writeFile(
		path.join(workerBundlerGeneratedDir, packageAppRemixModuleName),
		serialized,
	)
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
	const oauthProviderPackageDir = resolveOAuthProviderPackageDir()
	const remixPackageDir = resolveRemixPackageDir()
	const remixUiPackageDir = resolveRemixUiPackageDir()
	const isomorphicGitPackageDir = resolveIsomorphicGitPackageDir()
	const stampContent = await buildStampContent(
		bundlerPackageDir,
		oauthProviderPackageDir,
		remixPackageDir,
		remixUiPackageDir,
		isomorphicGitPackageDir,
	)
	await removeLeftoverSrcGeneratedBundlerArtifacts()
	await rm(path.join(workerBundlerGeneratedDir, 'esbuild-wasm.mjs'), {
		force: true,
	})
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
			'oauth-provider': path.join(
				oauthProviderPackageDir,
				'dist/oauth-provider.js',
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
	// isomorphic-git pulls Node-oriented deps (`buffer`, `sha.js`, …). Leave
	// those bundled for the browser/Workers target — the shared externals
	// plugin would mark `node:buffer` external and break both Node smoke
	// loads and the Workers additional-module evaluation.
	await build({
		entryPoints: {
			'isomorphic-git': isomorphicGitAdditionalEntryPath,
		},
		bundle: true,
		format: 'esm',
		platform: 'browser',
		target: 'es2022',
		minify: true,
		outdir: workerBundlerGeneratedDir,
		outExtension: { '.js': '.mjs' },
		mainFields: ['browser', 'module', 'main'],
		conditions: ['worker', 'browser', 'import', 'default'],
		logLevel: 'silent',
	})
	await copyFile(
		path.join(bundlerPackageDir, 'dist/esbuild.wasm'),
		path.join(workerBundlerGeneratedDir, 'esbuild.wasm'),
	)
	await buildPackageAppRemixModule(remixPackageDir, remixUiPackageDir)
	await writeFile(stampPath, stampContent)
	await rm(path.join(workerBundlerGeneratedDir, 'esbuild-wasm.mjs'), {
		force: true,
	})
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
