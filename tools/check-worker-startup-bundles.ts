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
		// Search package export headings (`package:{id}#{subpath}`) add a
		// few hundred bytes: local dry-run 5_095_156 bytes.
		// communityForkAdopt interactive-MCP gate (refuse package-runtime
		// self-adopt of user-secret read): local dry-run 5_096_278 bytes.
		// Destination-verify Cloudflare delivery index
		// (email_destination_verification) on the shared add/resend path:
		// local dry-run 5_097_119 bytes.
		// Flag-gated Jev search experiment (`jev-search-rerank` registry
		// entry plus shared search list wiring) spilled ~5 KB into the
		// platform entry: CI measured 5_102_980 bytes against the previous
		// 5_098_000 budget.
		// List-mode search `serverTiming` (execute-shaped `{ name,
		// durationMs }` including `jevRerank`) adds a few hundred bytes:
		// CI dry-run 5_105_268 against the previous 5_105_000 budget.
		// Jev Score question batching (merge/parse plus expected/received
		// errorReason) adds a few hundred bytes on top of that wiring.
		// Per-user MCP/meta search abuse rate limits (burst + daily D1
		// checkRateLimit before embeddings/Jev, not an entitlement) add
		// ~2 KB: local dry-run 5_112_004 against the previous 5_110_000
		// budget.
		// First-pass package export candidates (`package:{id}#{subpath}`
		// promotion + bounded hydrate) add a few KB on top of that wiring:
		// prior CI dry-run 5_112_939 against 5_110_000 before the rate-limit
		// bump; keep headroom for both.
		// Paid Jev necessity + high-confidence export call-contract attach
		// spill into platform: CI/local dry-run 5_120_066 against the
		// previous 5_118_000 budget.
		// Search list dual-channel parity (markdown carries the same
		// actionable export-contract / next-step / notices substance as
		// structured): CI dry-run 5_124_196 against the previous 5_124_000
		// budget.
		// Export parent-identity fold, close top-K promotion, and adaptive
		// Jev keep spill into platform: local dry-run 5_126_440 against the
		// previous 5_126_000 budget.
		// First-seen search funnel claim sits on the shared activation stamp
		// that platform search already calls: local dry-run 5_128_692 against
		// the previous 5_128_000 budget.
		// MCP execute `invoke` codegen (flag-gated schema field, specifier
		// parse, thin passthrough) spilled ~3 KB into the platform entry:
		// CI dry-run 5_133_007 against the previous 5_130_000 budget.
		// File fragment anchors land here too: platform MCP statically
		// registers search, and esbuild keeps the lazy repo/coding domains
		// in this same entry, so line-anchor and file-anchor cannot stay
		// on runtime alone. CI dry-run 5_145_618 against the previous
		// 5_135_000 budget.
		// Allowlisted kody:runtime facades and the .__kody_virtual__ guards
		// ride the same module-graph code: local dry-run 5_147_977 against
		// the previous 5_146_000 budget (main measured 5_145_651 locally).
		// Background-lane suspension gate (same modules as runtime) adds
		// ~1.1 KB on top: local dry-run 5_149_225 against the previous
		// 5_149_000 budget.
		// Opaque packageSecrets.get + share-grant remap / derived-ops on the
		// platform startup graph: local dry-run 5_151_668 against the previous
		// 5_150_000 budget.
		// Sibling daily automation quota (`automation_invocations_per_day`)
		// spills into the platform MCP invoke graph. Combined with opaque
		// secrets on main: local dry-run 5_153_557 against the previous
		// 5_153_000 budget.
		// Jev paid ranked-search exposure recording (dedicated site + shared
		// evaluation cache on MCP search) on the same entry.
		maxEntryBytes: 5_156_000,
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
		// Flag-gated Jev Score search rerank (`search-jev-rerank.ts` plus
		// list-mode wiring) added ~2.4 KB: CI measured 3_782_433 bytes
		// against the previous 3_780_000 budget.
		// Jev Score question batching (merge/parse plus expected/received
		// errorReason) adds ~2 KB: local dry-run 3_784_520 bytes against
		// the previous 3_785_000 budget.
		// Gateway envelope unwrap plus incomplete-answer key sampling adds
		// a few KB: CI dry-run 3_788_951 bytes against the previous
		// 3_788_000 budget.
		// First-pass package export candidates spill shared search package
		// plugin code into runtime: CI dry-run 3_793_904 against the
		// previous 3_792_000 budget.
		// Paid Jev necessity + high-confidence export call-contract attach
		// adds a few KB: CI dry-run 3_798_379 against the previous
		// 3_795_000 budget.
		// Feature-flag `experiments_opt_in` audience (users.experiments_opt_in
		// batch read + gate) measured ~1.3 KB on the prior base (CI dry-run
		// 3_796_324); fits within this headroom after the paid-Jev bump.
		// Export parent-identity fold, close top-K promotion, and adaptive
		// Jev keep (`selectJevKeptCandidates`) add ~1.3 KB: local dry-run
		// 3_803_286 against the previous 3_802_000 budget.
		// First-seen execute/search/secret/job funnel claim lives on the
		// shared activation-stamp module that runtime execute already calls:
		// local dry-run 3_806_157 against the previous 3_805_000 budget.
		// Onboarding ecosystem count plus Cursor Local/Cloud grant labels
		// sit on the inbound grant path runtime already loads: CI dry-run
		// 3_808_070 against the previous 3_808_000 budget.
		// Module-local secret-authority ALS (no Symbol.for runner) plus the
		// sealed reinstallable getter: CI dry-run 3_809_234 against the
		// previous 3_809_000 budget (local dry-run 3_808_685).
		// File fragment anchors (`#L165`, `#L165-L180`, markdown heading
		// slugs) on search entity, repoReadFile, and package file open pull
		// line-anchor and file-anchor into runtime: CI dry-run 3_820_542
		// against the previous 3_810_000 budget.
		// Allowlisted kody:runtime facades, the .__kody_virtual__ build
		// rejection, and the hardened computed import() guard: CI dry-run
		// 3_822_747 (local 3_822_879 with the node_modules rewrite) against
		// the previous 3_821_000 budget.
		// Opaque packageSecrets.get + share-grant owner remap / derived-ops
		// parsing on the runtime startup graph: CI dry-run 3_824_901 against
		// the previous 3_824_000 budget.
		// Background-lane suspension gate (`AccountSuspendedError` in the
		// background resolver, package-invocation 403 mapping, realtime
		// connect, per-hook, and emit/broadcast checks, pre-ledger invoke check,
		// non-retryable workflow step) adds ~1.1 KB on top: local dry-run
		// 3_824_132 against the previous 3_824_000 budget (main). Combined with
		// opaque-secrets graph growth: raise reviewed budget to 3_828_000.
		// Sibling daily automation quota (`automation_invocations_per_day`)
		// on package-invocation module-execution pulls entitlement consume
		// into runtime. Combined with opaque-secrets + suspension on main:
		// local dry-run 3_828_451 against the previous 3_828_000 budget.
		// Jev paid ranked-search exposure recording (dedicated site + shared
		// evaluation cache helpers on the search path that runtime already
		// loads) on the same entry.
		maxEntryBytes: 3_831_000,
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
