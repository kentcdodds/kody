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
		// Waiting first-use probes (search, memory, execute, package, job,
		// integration, secret, Discord membership) ship on platform because
		// waitingSummary runs in the MCP Durable Object. UserMeter schema
		// v12 inbound MCP last-used RPCs add a few KB (CI dry-run
		// 4_992_191). Keep last-used on this class; do not add a second DO.
		// Package-app `kody.app.client` browser bundling and `/_assets/*`
		// serving (publish rebuild and packageAppFetch both run here) add
		// ~12 KB on top: local dry-run 5_004_707 bytes.
		// emailDestination list/add/set-default/remove plus emailSend
		// destination resolution add ~23 KB: local dry-run 5_028_263 bytes.
		// MCP OAuth token-recovery persist/stamp on McpClientHub (refresh
		// before wipe, durable last_error when a previously-ready server
		// parks authenticating) adds ~2 KB: CI dry-run 5_036_978 bytes.
		// Package publish stamps identity-icon derivatives from
		// finalizePublishedEntitySource: local dry-run 5_046_681 bytes.
		// MCP connection-event ack-by-id plus last_error keep-until-ready
		// on McpClientHub: CI dry-run 5_050_804 bytes.
		// MCP OAuth sidecar refresh-token preserve (merge omitted RT,
		// restore when client_id missing, remint/invalidate delete sidecar,
		// nested discovery refresh advertising): CI dry-run 5_063_749 bytes.
		// Provider-secret placeholders on the shared fetch-gateway path
		// (bindings, grants, sealed resolve) plus the MCP OAuth sidecar
		// preserve: local dry-run 5_088_887 bytes.
		maxEntryBytes: 5_095_000,
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
		// Listing-only helpers live in the shared secrets service module
		// (resolveSecretListScopeOrder / listSecretBucketsByScope). Runtime
		// does not call them, but they sit in the same module as resolve
		// and add a few KB. Share-grant import/storage routing added more.
		// secretJwtSign JWA families (HMAC/PSS/ES plus extra RSA hashes)
		// add ~0.5KB. Split listing out of service.ts or the share-grant
		// runtime path if this budget is raised again. Package-app
		// `/_assets/*` serving (fingerprinted client module, static assets
		// directory) runs here: local dry-run 3_701_307 bytes. The Remix
		// package-app runtime (mounted-URL dispatch in the wrapper source,
		// runtime resolution, and the deferred-module loader for the vendored
		// remix file set — the ~0.5 MB file set itself stays in
		// `package-app-remix.mjs`) adds ~11 KB: local dry-run 3_712_214 bytes.
		// emailSend destination resolution (verified extras plus default) lives
		// on the shared outbound send path: local dry-run 3_725_245 bytes.
		// Repo/package list marks (`refreshIdentityIconForSource` on
		// `repo.pushed`) add identity-icon keying and the existing community
		// icon ingest path: local dry-run 3_736_186 bytes.
		// RunLog `inspectSqlBilling` (content-free admin SQL snapshot) adds
		// PRAGMA/COUNT/EXPLAIN helpers on the DO class: CI measured
		// 3_741_747 bytes against the previous 3_740_000 budget.
		// Provider-secret placeholders on the shared fetch-gateway path
		// (`{{secret/<provider>:<ref>}}`, sealed resolve, grants) pull
		// secret-providers/service.ts into runtime: CI dry-run 3_768_307
		// bytes against the previous 3_745_000 budget.
		maxEntryBytes: 3_780_000,
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
