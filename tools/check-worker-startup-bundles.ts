import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { ensureGuideCatalogModules } from './build-guide-catalog-modules.ts'
import { ensureWorkerBundlerModules } from './build-worker-bundler-modules.ts'
import { isExecutedDirectly, resolveLocalBinary } from './node-runtime.ts'
import { writeRuntimeDryRunConfig } from './local-runtime-dev-config.ts'
import {
	buildOriginProductionViteBundle,
	findOriginViteDeferredAssets,
} from './origin-vite-startup-build.ts'

const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

export type StartupBundleName = 'origin' | 'platform' | 'runtime'

export const startupBundleBudgetPath = path.join(
	repoRoot,
	'tools',
	'worker-startup-bundle-budget.json',
)

type StartupBundleDefinition = {
	name: StartupBundleName
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
	 * Wrangler 4.131+ applies the local sqlite-class map on `deploy --dry-run`.
	 * Runtime's committed production chain transfers then deletes
	 * `PackageServiceInstance`; localize that chain for this check only.
	 */
	localizeMigrationsForDryRun?: boolean
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
 * synchronous web `/docs` pages, so it can't just forbid every
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
/**
 * The pre-bundled `remix` file set package bundles receive as
 * `node_modules/remix/*` (~0.5 MB of string constants). Only the runtime
 * bundler path loads it, so it must stay a separate additional module.
 */
const packageAppRemixGeneratedModuleSourcePath =
	'/packages/worker/.generated/package-app-remix.mjs'
const packageAppRemixGeneratedModuleRelativePath = path.join(
	'node_modules',
	'.kody-generated',
	'package-app-remix.mjs',
)
const workerBundlerWasmRelativePath = path.join(
	'node_modules',
	'.kody-generated',
	'esbuild.wasm',
)

type StartupBundleSpec = Omit<StartupBundleDefinition, 'maxEntryBytes'>

export type StartupBundleBudget = Record<StartupBundleName, number>

const startupBundleNames = ['origin', 'platform', 'runtime'] as const

/** Structural defs only. Byte ceilings: worker-startup-bundle-budget.json. */
export const startupBundles: ReadonlyArray<StartupBundleSpec> = [
	{
		name: 'origin',
		packageDir: 'packages/worker',
		entryFile: 'index.js',
		bundler: 'vite',
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
		localizeMigrationsForDryRun: true,
		forbiddenSources: [
			...sharedDeferredGuideSources,
			'/packages/worker/src/repo/repo-session-do.ts',
			oauthProviderPackageSourcePath,
		],
	},
]

export async function readStartupBundleBudget(
	budgetPath = startupBundleBudgetPath,
): Promise<StartupBundleBudget> {
	const parsed = JSON.parse(await readFile(budgetPath, 'utf8')) as unknown
	if (!parsed || typeof parsed !== 'object') {
		throw new Error(`Invalid startup bundle budget file at ${budgetPath}`)
	}
	const budget = parsed as Record<string, unknown>
	const resolved = {} as StartupBundleBudget
	for (const name of startupBundleNames) {
		const maxEntryBytes = budget[name]
		if (typeof maxEntryBytes !== 'number' || maxEntryBytes <= 0) {
			throw new Error(
				`Invalid startup bundle budget for ${name} at ${budgetPath}`,
			)
		}
		resolved[name] = maxEntryBytes
	}
	return resolved
}

function withStartupBundleBudget(
	spec: StartupBundleSpec,
	budget: StartupBundleBudget,
): StartupBundleDefinition {
	return {
		...spec,
		maxEntryBytes: budget[spec.name],
	}
}

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
	if (
		sources.some((source) =>
			source.includes(packageAppRemixGeneratedModuleSourcePath),
		)
	) {
		throw new Error(
			`${definition.name} startup bundle inlines the generated package-app Remix file set (${packageAppRemixGeneratedModuleSourcePath}) into its main module instead of loading it as a separate additional module.`,
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
	try {
		await stat(path.join(outputDir, packageAppRemixGeneratedModuleRelativePath))
	} catch {
		throw new Error(
			`${name} startup bundle did not emit ${packageAppRemixGeneratedModuleRelativePath} as a separate additional module (find_additional_modules regression?).`,
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
	if (assets.packageAppRemix.length === 0) {
		throw new Error(
			`${name} Vite startup bundle did not emit a separate package-app-remix chunk (dynamic import() regression?).`,
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
	const wranglerConfig = definition.localizeMigrationsForDryRun
		? path.relative(
				cwd,
				await writeRuntimeDryRunConfig({
					runtimeConfigPath: path.join(cwd, 'wrangler.jsonc'),
					envName: 'production',
				}),
			)
		: 'wrangler.jsonc'
	await execFileAsync(
		wranglerBinary,
		[
			'deploy',
			...(definition.entryOverride ? [definition.entryOverride] : []),
			'--dry-run',
			'--outdir',
			outputDir,
			'--config',
			wranglerConfig,
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
	const budget = await readStartupBundleBudget()
	const outputRoot = await mkdtemp(path.join(tmpdir(), 'kody-startup-bundles-'))
	const wranglerBinary = resolveLocalBinary('wrangler')
	try {
		const results = await Promise.all(
			startupBundles.map((spec) =>
				inspectStartupBundle(
					withStartupBundleBudget(spec, budget),
					outputRoot,
					wranglerBinary,
				),
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
