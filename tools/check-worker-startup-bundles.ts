import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { ensureGuideCatalogModules } from './build-guide-catalog-modules.ts'
import { ensureWorkerBundlerModules } from './build-worker-bundler-modules.ts'
import { isExecutedDirectly, resolveLocalBinary } from './node-runtime.ts'
import {
	buildOriginProductionViteBundle,
	findOriginViteDeferredAssets,
} from './origin-vite-startup-build.ts'

const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

type StartupBundleDefinition = {
	name: string
	packageDir: string
	entryFile: string
	maxEntryBytes: number
	forbiddenSources: ReadonlyArray<string>
	/**
	 * How the production entry is built for this check. Origin ships through
	 * Vite (`tools/deploy.ts`); platform and runtime still use Wrangler.
	 * Origin's slim `production-worker.ts` is deploy-generated only — the
	 * committed `packages/worker/wrangler.jsonc` never points `env.production`
	 * at it — so the Vite path writes a temporary config with that `main`.
	 */
	bundler: 'vite' | 'wrangler'
	/**
	 * Positional entry-point override passed to `wrangler deploy`, relative
	 * to `packageDir`. Platform and runtime already commit their own
	 * top-level `main`, so they need no override.
	 */
	entryOverride?: string
}

const sharedDeferredGuideSources = [
	'/packages/worker/src/guides/catalog.ts',
	'/packages/worker/src/guides/parse-frontmatter.ts',
	'/docs/guides/',
] as const

/**
 * The full parsed guide catalog (with bodies) must never end up inlined into
 * any of these three main modules — see the `find_additional_modules` rule
 * in each package's `wrangler.jsonc` and the doc comment on
 * `tools/build-guide-catalog-modules.ts`. Checked for every bundle,
 * independent of `forbiddenSources`: origin legitimately imports
 * `guides/catalog.ts` (its own doc source, not the generated module) for the
 * synchronous web `/guides` pages, so it can't just forbid every
 * guide-related source the way platform/runtime do.
 */
const guideCatalogGeneratedModuleSourcePath =
	'/packages/worker/src/generated/guide-catalog.mjs'
const guideCatalogGeneratedModuleRelativePath = path.join(
	'generated',
	'guide-catalog.mjs',
)
const workerBundlerGeneratedModuleSourcePath =
	'/packages/worker/.generated/worker-bundler.mjs'
const workerBundlerGeneratedModuleRelativePath = path.join(
	'node_modules',
	'.kody-generated',
	'worker-bundler.mjs',
)
/**
 * `#worker/oauth-helpers.ts` loads the OAuth provider from this generated
 * module when `OAUTH_PROVIDER` is absent. Origin imports the library
 * statically for its `fetch` wrapper; platform and runtime must not, so the
 * package source is a forbidden main-module source there.
 */
const oauthProviderGeneratedModuleSourcePath =
	'/packages/worker/.generated/oauth-provider.mjs'
const oauthProviderGeneratedModuleRelativePath = path.join(
	'node_modules',
	'.kody-generated',
	'oauth-provider.mjs',
)
const oauthProviderPackageSourcePath =
	'/node_modules/@cloudflare/workers-oauth-provider/'
const workerBundlerWasmRelativePath = path.join(
	'node_modules',
	'.kody-generated',
	'esbuild.wasm',
)

const startupBundles: ReadonlyArray<StartupBundleDefinition> = [
	{
		name: 'origin',
		packageDir: 'packages/worker',
		entryFile: 'index.js',
		bundler: 'vite',
		maxEntryBytes: 7_750_000,
		forbiddenSources: [
			'/packages/worker/src/index.ts',
			'/packages/worker/src/repo/repo-session-do.ts',
		],
	},
	{
		name: 'platform',
		packageDir: 'packages/platform-worker',
		entryFile: 'platform-worker.js',
		bundler: 'wrangler',
		maxEntryBytes: 4_975_000,
		forbiddenSources: [
			...sharedDeferredGuideSources,
			oauthProviderPackageSourcePath,
		],
	},
	{
		name: 'runtime',
		packageDir: 'packages/runtime-worker',
		entryFile: 'runtime-worker.js',
		bundler: 'wrangler',
		maxEntryBytes: 3_620_000,
		forbiddenSources: [
			...sharedDeferredGuideSources,
			'/packages/worker/src/repo/repo-session-do.ts',
			oauthProviderPackageSourcePath,
		],
	},
]

function normalizeSourcePath(source: string) {
	return source.replaceAll('\\', '/')
}

function readSourceMapSources(sourceMapText: string, name: string) {
	const sourceMap = JSON.parse(sourceMapText) as { sources?: unknown }
	if (
		!Array.isArray(sourceMap.sources) ||
		!sourceMap.sources.every((source) => typeof source === 'string')
	) {
		throw new Error(`${name} startup bundle emitted a malformed source map.`)
	}
	return sourceMap.sources.map(normalizeSourcePath)
}

function assertDeferredSourcesStayOutOfMain(
	definition: StartupBundleDefinition,
	sources: ReadonlyArray<string>,
) {
	const violations = definition.forbiddenSources.filter((forbiddenSource) =>
		sources.some((source) => source.includes(forbiddenSource)),
	)
	if (violations.length > 0) {
		throw new Error(
			`${definition.name} startup bundle includes deferred-only source(s): ${violations.join(', ')}`,
		)
	}
	if (
		sources.some((source) =>
			source.includes(guideCatalogGeneratedModuleSourcePath),
		)
	) {
		throw new Error(
			`${definition.name} startup bundle inlines the generated guide catalog (${guideCatalogGeneratedModuleSourcePath}) into its main module instead of loading it as a separate additional module.`,
		)
	}
	if (
		sources.some((source) =>
			source.includes(workerBundlerGeneratedModuleSourcePath),
		)
	) {
		throw new Error(
			`${definition.name} startup bundle inlines the generated worker bundler (${workerBundlerGeneratedModuleSourcePath}) into its main module instead of loading it as a separate additional module.`,
		)
	}
	if (
		sources.some((source) =>
			source.includes(oauthProviderGeneratedModuleSourcePath),
		)
	) {
		throw new Error(
			`${definition.name} startup bundle inlines the generated OAuth provider (${oauthProviderGeneratedModuleSourcePath}) into its main module instead of loading it as a separate additional module.`,
		)
	}
}

async function assertWranglerAdditionalModules(
	outputDir: string,
	name: string,
) {
	try {
		await stat(path.join(outputDir, guideCatalogGeneratedModuleRelativePath))
	} catch {
		throw new Error(
			`${name} startup bundle did not emit ${guideCatalogGeneratedModuleRelativePath} as a separate additional module (find_additional_modules regression?).`,
		)
	}
	try {
		await stat(path.join(outputDir, workerBundlerGeneratedModuleRelativePath))
		await stat(path.join(outputDir, workerBundlerWasmRelativePath))
	} catch {
		throw new Error(
			`${name} startup bundle did not emit ${workerBundlerGeneratedModuleRelativePath} and ${workerBundlerWasmRelativePath} as separate additional modules (find_additional_modules regression?).`,
		)
	}
	try {
		await stat(path.join(outputDir, oauthProviderGeneratedModuleRelativePath))
	} catch {
		throw new Error(
			`${name} startup bundle did not emit ${oauthProviderGeneratedModuleRelativePath} as a separate additional module (find_additional_modules regression?).`,
		)
	}
}

function assertOriginViteDeferredChunks(
	assetNames: ReadonlyArray<string>,
	name: string,
) {
	const assets = findOriginViteDeferredAssets(assetNames)
	if (assets.guideCatalog.length === 0) {
		throw new Error(
			`${name} Vite startup bundle did not emit a separate guide-catalog chunk (dynamic import() regression?).`,
		)
	}
	if (assets.oauthProvider.length === 0) {
		throw new Error(
			`${name} Vite startup bundle did not emit a separate oauth-provider chunk (dynamic import() regression?).`,
		)
	}
	if (assets.workerBundler.length === 0) {
		throw new Error(
			`${name} Vite startup bundle did not emit a separate worker-bundler chunk (dynamic import() regression?).`,
		)
	}
	if (assets.esbuildWasm.length === 0) {
		throw new Error(
			`${name} Vite startup bundle did not emit esbuild.wasm as a separate asset (dynamic import() regression?).`,
		)
	}
}

async function inspectViteOriginStartupBundle(
	definition: StartupBundleDefinition,
	outputRoot: string,
) {
	const build = await buildOriginProductionViteBundle(
		path.join(outputRoot, definition.name),
	)
	const [{ size }, sourceMapText, assetNames] = await Promise.all([
		stat(build.entryPath),
		readFile(build.sourceMapPath, 'utf8'),
		readdir(build.assetsDir),
	])
	const sources = readSourceMapSources(sourceMapText, definition.name)
	assertDeferredSourcesStayOutOfMain(definition, sources)
	assertOriginViteDeferredChunks(assetNames, definition.name)
	if (size > definition.maxEntryBytes) {
		throw new Error(
			`${definition.name} startup entry is ${String(size)} bytes, exceeding its ${String(definition.maxEntryBytes)}-byte reviewed budget.`,
		)
	}
	return {
		name: definition.name,
		size,
		maxEntryBytes: definition.maxEntryBytes,
	}
}

async function inspectWranglerStartupBundle(
	definition: StartupBundleDefinition,
	outputRoot: string,
	wranglerBinary: string,
) {
	const outputDir = path.join(outputRoot, definition.name)
	const cwd = path.join(repoRoot, definition.packageDir)
	await execFileAsync(
		wranglerBinary,
		[
			'deploy',
			...(definition.entryOverride ? [definition.entryOverride] : []),
			'--dry-run',
			'--outdir',
			outputDir,
			'--config',
			'wrangler.jsonc',
			'--env',
			'production',
		],
		{
			cwd,
			maxBuffer: 10 * 1024 * 1024,
		},
	)

	const entryPath = path.join(outputDir, definition.entryFile)
	const sourceMapPath = `${entryPath}.map`
	const [{ size }, sourceMapText] = await Promise.all([
		stat(entryPath),
		readFile(sourceMapPath, 'utf8'),
	])
	const sources = readSourceMapSources(sourceMapText, definition.name)
	assertDeferredSourcesStayOutOfMain(definition, sources)
	await assertWranglerAdditionalModules(outputDir, definition.name)
	if (size > definition.maxEntryBytes) {
		throw new Error(
			`${definition.name} startup entry is ${String(size)} bytes, exceeding its ${String(definition.maxEntryBytes)}-byte reviewed budget.`,
		)
	}

	return {
		name: definition.name,
		size,
		maxEntryBytes: definition.maxEntryBytes,
	}
}

async function inspectStartupBundle(
	definition: StartupBundleDefinition,
	outputRoot: string,
	wranglerBinary: string,
) {
	switch (definition.bundler) {
		case 'vite':
			return inspectViteOriginStartupBundle(definition, outputRoot)
		case 'wrangler':
			return inspectWranglerStartupBundle(
				definition,
				outputRoot,
				wranglerBinary,
			)
		default: {
			const exhaustive: never = definition.bundler
			throw new Error(`Unhandled startup bundler: ${String(exhaustive)}`)
		}
	}
}

/**
 * Builds the three production entry modules and enforces deterministic
 * startup proxies: reviewed main-module size budgets and import-graph
 * boundaries for code that must stay deferred. Cloudflare's measured startup
 * CPU varies by validation host, so this gate stays deterministic (bytes and
 * import graph); `check-worker-startup-time.ts` adds the sampled-CPU
 * tripwire on top of it.
 */
export async function checkWorkerStartupBundles() {
	await Promise.all([ensureWorkerBundlerModules(), ensureGuideCatalogModules()])
	const outputRoot = await mkdtemp(path.join(tmpdir(), 'kody-startup-bundles-'))
	const wranglerBinary = resolveLocalBinary('wrangler')
	try {
		const results = await Promise.all(
			startupBundles.map((definition) =>
				inspectStartupBundle(definition, outputRoot, wranglerBinary),
			),
		)
		for (const result of results) {
			console.log(
				`${result.name} startup entry: ${String(result.size)} / ${String(result.maxEntryBytes)} bytes`,
			)
		}
	} finally {
		await rm(outputRoot, { recursive: true, force: true })
	}
}

if (isExecutedDirectly(import.meta.url)) {
	await checkWorkerStartupBundles()
}
