import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runWithDynamicWorkerEvaluationBudget } from '#mcp/executor.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import { resolveBackgroundMcpUser } from '#worker/identity/background-mcp-user.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import { loadPublishedBundleArtifactByIdentity } from '#worker/package-runtime/published-bundle-artifacts.ts'
import {
	type PackageRetrieverManifestCacheEntry,
	type PackageRetrieverResult,
	type PackageRetrieverScope,
	type PackageRetrieverSurfaceResult,
	packageRetrieverOutputSchema,
} from './types.ts'
import { listPackageRetrieversForScope } from './manifest-cache.ts'

const defaultSearchLimit = 5
const defaultContextLimit = 2
const maxSearchLimit = 20
const maxContextLimit = 3
// Retrievers are optional enrichment. Keep budgets bounded so a slow package
// cannot dominate search/execute wall time, while leaving context retrievers
// enough headroom for cold isolate + packageStorage work. Individual failures
// must not fail the tool.
const defaultSearchTimeoutMs = 3_000
const defaultContextTimeoutMs = 2_500
const maxSearchTimeoutMs = 5_000
const maxContextTimeoutMs = 3_000
const maxResultSummaryLength = 1_000
const maxResultDetailsLength = 4_000

function createRepoContext(source: EntitySourceRow) {
	return {
		sourceId: source.id,
		repoId: source.repo_id,
		sessionId: null,
		baseCommit: source.published_commit,
		manifestPath: source.manifest_path,
		sourceRoot: source.source_root,
		publishedCommit: source.published_commit,
		entityKind: source.entity_kind,
		entityId: source.entity_id,
	}
}

function buildPackageRetrieverStorageId(packageId: string) {
	// Names the package bucket (same shape as buildPackageStorageId). Since the
	// ambient `storage` binding was removed from retriever runs, this only
	// feeds `callerContext.storageContext` and runtime-debug metadata —
	// retriever code reaches the bucket via `packageStorage()`.
	return `package:${encodeURIComponent(packageId)}`
}

function clampLimit(value: number | null, scope: PackageRetrieverScope) {
	const fallback =
		scope === 'context' ? defaultContextLimit : defaultSearchLimit
	const max = scope === 'context' ? maxContextLimit : maxSearchLimit
	return Math.min(max, Math.max(1, value ?? fallback))
}

function clampTimeout(value: number | null, scope: PackageRetrieverScope) {
	const fallback =
		scope === 'context' ? defaultContextTimeoutMs : defaultSearchTimeoutMs
	const max = scope === 'context' ? maxContextTimeoutMs : maxSearchTimeoutMs
	return Math.min(max, Math.max(1, value ?? fallback))
}

function truncate(value: string | undefined, maxLength: number) {
	if (value === undefined) return undefined
	return value.length <= maxLength ? value : value.slice(0, maxLength)
}

function normalizeRetrieverResults(input: {
	entry: PackageRetrieverManifestCacheEntry
	results: Array<PackageRetrieverResult>
}): Array<PackageRetrieverSurfaceResult> {
	return input.results.map((result) => ({
		...result,
		summary: truncate(result.summary, maxResultSummaryLength) ?? '',
		details: truncate(result.details, maxResultDetailsLength),
		packageId: input.entry.packageId,
		kodyId: input.entry.kodyId,
		retrieverKey: input.entry.retrieverKey,
		retrieverName: input.entry.name,
	}))
}

async function invokeRetriever(input: {
	env: Env
	baseUrl: string
	userId: string
	scope: PackageRetrieverScope
	entry: PackageRetrieverManifestCacheEntry
	query: string
	includeHiddenPackages: boolean
	memoryContext?: {
		task?: string
		query?: string
		entities?: Array<string>
		constraints?: Array<string>
	} | null
	conversationId?: string
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const savedPackage = await getSavedPackageById(input.env.APP_DB, {
		userId: input.userId,
		packageId: input.entry.packageId,
	})
	if (!savedPackage) {
		return []
	}
	// Hidden gating is a search-discovery preference only. Context retrievers
	// (memory/tool context) must still run for hidden packages.
	if (
		input.scope === 'search' &&
		savedPackage.hidden &&
		!input.includeHiddenPackages
	) {
		return []
	}
	const source = await getEntitySourceById(
		input.env.APP_DB,
		input.entry.sourceId,
	)
	if (
		!source ||
		!source.published_commit ||
		source.published_commit !== input.entry.revision
	) {
		return []
	}
	const loaded = await loadPublishedBundleArtifactByIdentity({
		env: input.env,
		userId: input.userId,
		sourceId: input.entry.sourceId,
		kind: 'module',
		artifactName: input.entry.exportName,
		entryPoint: input.entry.entryPoint,
	})
	if (!loaded?.artifact) {
		return []
	}
	const limit = clampLimit(input.entry.maxResults, input.scope)
	const callerContext = createMcpCallerContext({
		baseUrl: input.baseUrl,
		executionOrigin: 'background',
		user: await resolveBackgroundMcpUser(input.env.APP_DB, input.userId),
		storageContext: {
			sessionId: null,
			appId: input.entry.packageId,
			packageId: input.entry.packageId,
			storageId: buildPackageRetrieverStorageId(input.entry.packageId),
		},
		repoContext: createRepoContext(source),
	})
	const packageContext = {
		packageId: input.entry.packageId,
		kodyId: input.entry.kodyId,
		sourceId: input.entry.sourceId,
	}
	const runRecord = {
		packageId: input.entry.packageId,
		kodyId: input.entry.kodyId,
		sourceId: input.entry.sourceId,
		publishedCommit: source.published_commit,
		surface: 'retriever' as const,
		name: input.entry.retrieverKey,
		storageId: buildPackageRetrieverStorageId(input.entry.packageId),
		metadata: {
			scope: input.scope,
			limit,
		},
	}
	// Avoid a top-level package-retrievers -> package-invocations cycle during
	// capability registry initialization.
	const { createPackageEventTools, createPackageRuntimeInvokeTools } =
		await import('#worker/package-invocations/service.ts')
	const packageRuntimeToolsInput = {
		env: input.env,
		baseUrl: input.baseUrl,
		callerContext,
		packageContext,
		parentRunRecord: runRecord,
		packageInvokeDepth: 0,
		waitUntil: input.waitUntil,
	}
	const executionResult = await runBundledModuleWithRegistry(
		input.env,
		callerContext,
		{
			mainModule: loaded.artifact.mainModule,
			modules: loaded.artifact.modules,
			dependencies: loaded.artifact.dependencies,
		},
		{
			query: input.query,
			scope: input.scope,
			memoryContext: input.memoryContext ?? null,
			limit,
			conversationId: input.conversationId ?? null,
		},
		{
			// No ambient `storage` binding: retriever code reaches the package
			// bucket via `packageStorage()` (granted through packageContext
			// below). The old read-only ambient binding constrained only the
			// ambient helper — `packageStorage()` has been writable in retriever
			// context since it shipped — so retrievers staying read-mostly is a
			// convention, not a runtime constraint.
			packageContext,
			runRecord,
			packageInvokeTools: createPackageRuntimeInvokeTools(
				packageRuntimeToolsInput,
			),
			packageEventTools: createPackageEventTools(packageRuntimeToolsInput),
			executorTimeoutMs: clampTimeout(input.entry.timeoutMs, input.scope),
			waitUntil: input.waitUntil,
		},
	)
	if (executionResult.error) {
		throw new Error(getErrorMessage(executionResult.error))
	}
	const parsed = packageRetrieverOutputSchema.safeParse(executionResult.result)
	if (!parsed.success) {
		throw new Error(
			`Retriever "${input.entry.retrieverKey}" returned an invalid result shape.`,
		)
	}
	return normalizeRetrieverResults({
		entry: input.entry,
		results: parsed.data.results.slice(0, limit),
	})
}

async function loadScopeEntries(input: {
	env: Env
	userId: string
	scope: PackageRetrieverScope
}) {
	return (await listPackageRetrieversForScope(input))
		.filter((entry) => entry.scopes.includes(input.scope))
		.sort(
			(left, right) =>
				left.kodyId.localeCompare(right.kodyId) ||
				left.retrieverKey.localeCompare(right.retrieverKey),
		)
}

export async function runPackageRetrievers(input: {
	env: Env
	baseUrl: string
	userId: string | null
	scope: PackageRetrieverScope
	query: string
	includeHiddenPackages?: boolean
	memoryContext?: {
		task?: string
		query?: string
		entities?: Array<string>
		constraints?: Array<string>
	} | null
	conversationId?: string
	maxProviders?: number
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const userId = input.userId?.trim()
	const query = input.query.trim()
	const includeHiddenPackages = !!input.includeHiddenPackages
	if (!userId || !query) {
		return {
			results: [],
			warnings: [],
		}
	}
	if (!('BUNDLE_ARTIFACTS_KV' in input.env)) {
		throw new Error(
			'BUNDLE_ARTIFACTS_KV binding is required for package retrievers.',
		)
	}
	const entries = (
		await loadScopeEntries({
			env: input.env,
			userId,
			scope: input.scope,
		})
	).slice(0, input.maxProviders ?? (input.scope === 'context' ? 3 : 10))
	// Soft-fail per retriever: one stalled/buggy package must not fail MCP
	// `search` or pre-sandbox execute memory/context enrichment. Callers already
	// surface `warnings` to agents.
	const settled = await runWithDynamicWorkerEvaluationBudget(
		async () =>
			await Promise.allSettled(
				entries.map((entry) =>
					invokeRetriever({
						env: input.env,
						baseUrl: input.baseUrl,
						userId,
						scope: input.scope,
						entry,
						query,
						includeHiddenPackages,
						memoryContext: input.memoryContext,
						conversationId: input.conversationId,
						waitUntil: input.waitUntil,
					}),
				),
			),
	)
	const results: Array<PackageRetrieverSurfaceResult> = []
	const warnings: Array<string> = []
	for (let index = 0; index < settled.length; index += 1) {
		const outcome = settled[index]
		const entry = entries[index]
		if (!outcome || !entry) continue
		if (outcome.status === 'fulfilled') {
			results.push(...outcome.value)
			continue
		}
		const reason = getErrorMessage(outcome.reason)
		console.error(
			JSON.stringify({
				message: 'package retriever failed',
				packageId: entry.packageId,
				kodyId: entry.kodyId,
				retrieverKey: entry.retrieverKey,
				scope: input.scope,
				reason,
			}),
		)
		warnings.push(
			`Package retriever "${entry.kodyId}/${entry.retrieverKey}" failed and was skipped: ${reason}`,
		)
	}
	return {
		results: results.sort(
			(left, right) => (right.score ?? 0) - (left.score ?? 0),
		),
		warnings,
	}
}
