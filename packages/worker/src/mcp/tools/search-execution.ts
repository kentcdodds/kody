import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { runWithDynamicWorkerEvaluationBudget } from '#mcp/executor.ts'
import { buildMemoryRetrievalQuery } from '#mcp/tools/memory-tool-context.ts'
import { getPackageAppBaseUrl } from '#worker/app-base-url.ts'
import { resolvePublicUsername } from '#worker/identity/user-lookup.ts'
import { runPackageRetrievers } from '#worker/package-retrievers/service.ts'

import { resolvePackageIdentitySearch } from './package-search-identity.ts'
import { buildExactPackageSearchResult, searchUnified } from './search-core.ts'
import { loadSearchRowsAndRegistry } from './search-loaders.ts'
import {
	launchSearchMemoryEnrichment,
	resolveSearchMemoryContext,
	settleSearchMemoryEnrichment,
} from './search-memory.ts'
import { elapsedMs } from './search-timing.ts'
import {
	type SearchMemoryEnrichmentSettlement,
	type SearchPhaseTimings,
	type SearchUnifiedResult,
} from './search-types.ts'
import { type SearchToolArgs } from './search-tool-definition.ts'
import { queryMatchesSynthesizedProvider } from './search-provider-overview.ts'

export type SearchListExecutionResult = {
	result: SearchUnifiedResult
	username: string | null
	warnings: Array<string>
	memorySettlement: SearchMemoryEnrichmentSettlement
	phaseTimings: Partial<SearchPhaseTimings>
	capabilityGuidance?: string
}

type ExecuteSearchListInput = {
	env: Env
	callerContext: McpCallerContext
	conversationId: string
	query: string
	memoryQuery?: string
	limit: number
	userId: string | null
	includeHiddenPackages: boolean
	memoryContext?: SearchToolArgs['memoryContext']
	/** Optional capability domain id; scopes ranked results to that domain's capabilities. */
	domain?: string
}

export async function executeSearchList(
	input: ExecuteSearchListInput,
): Promise<SearchListExecutionResult> {
	// Memory enrichment (context-scope retrievers) and search-scope retrievers
	// each open their own Worker Loader evaluations. Cloudflare caps those at
	// four per incoming request; a shared budget lets the later wave queue
	// instead of failing at sandboxMs 0.
	return await runWithDynamicWorkerEvaluationBudget(
		async () => await executeSearchListWithinBudget(input),
	)
}

async function executeSearchListWithinBudget(
	input: ExecuteSearchListInput,
): Promise<SearchListExecutionResult> {
	const domainFilter = input.domain?.trim() || undefined
	const username = await resolvePublicUsername({
		db: input.env.APP_DB,
		username: input.callerContext.user?.username ?? null,
		email: input.callerContext.user?.email ?? null,
	})
	// Domain-scoped searches rank capabilities only; exact package identity
	// resolution does not apply.
	const identityResolution =
		input.query && !domainFilter
			? await resolvePackageIdentitySearch({
					db: input.env.APP_DB,
					userId: input.userId,
					query: input.query,
					baseUrl: input.callerContext.baseUrl,
					packageAppBaseUrl: getPackageAppBaseUrl({ env: input.env }),
					packageAppLegacyHosts: input.env.PACKAGE_APP_LEGACY_HOSTS,
					username,
					includeHiddenPackages: input.includeHiddenPackages,
				})
			: { recognized: false as const }
	let preloadedSearchRows: Awaited<
		ReturnType<typeof loadSearchRowsAndRegistry>
	> | null = null
	let identityMatchesProvider = false
	if (
		identityResolution.recognized &&
		identityResolution.match &&
		input.query.trim().toLowerCase() ===
			identityResolution.match.kodyId.toLowerCase()
	) {
		preloadedSearchRows = await loadSearchRowsAndRegistry({
			env: input.env,
			callerContext: input.callerContext,
			userId: input.userId,
			includeHiddenPackages: input.includeHiddenPackages,
		})
		identityMatchesProvider = queryMatchesSynthesizedProvider({
			query: input.query,
			registry: preloadedSearchRows.registry,
		})
	}
	const memoryContextRetrievalQuery = buildMemoryRetrievalQuery(
		input.memoryContext,
	)
	const shouldEnrichMemory =
		(Boolean(input.query) || Boolean(memoryContextRetrievalQuery)) &&
		(!identityResolution.recognized || identityMatchesProvider)
	const memoryLaunch = shouldEnrichMemory
		? launchSearchMemoryEnrichment({
				env: input.env,
				callerContext: input.callerContext,
				conversationId: input.conversationId,
				query: input.memoryQuery,
				memoryContext: input.memoryContext,
			})
		: null
	const memoryEnrichmentPromise = memoryLaunch?.promise ?? Promise.resolve(null)
	const memoryEnrichmentLaunchedAtMs = memoryLaunch?.launchedAtMs
	const phaseTimings: Partial<SearchPhaseTimings> = {}
	let warnings: Array<string> = []
	let result: SearchUnifiedResult
	let capabilityGuidance: string | undefined

	if (identityResolution.recognized && !identityMatchesProvider) {
		result = buildExactPackageSearchResult({
			env: input.env,
			query: input.query,
			match: identityResolution.match,
		})
		const memorySettlement: SearchMemoryEnrichmentSettlement = {
			warnings: [],
			phaseTimings: {},
		}
		warnings.push(...(preloadedSearchRows?.warnings ?? []))
		return {
			result,
			username,
			warnings,
			memorySettlement,
			phaseTimings,
		}
	}

	const rowAndRegistryLoadStart = performance.now()
	const rowsPromise = (
		preloadedSearchRows
			? Promise.resolve(preloadedSearchRows)
			: loadSearchRowsAndRegistry({
					env: input.env,
					callerContext: input.callerContext,
					userId: input.userId,
					includeHiddenPackages: input.includeHiddenPackages,
				})
	).then((rows) => {
		phaseTimings.rowAndRegistryLoadMs = elapsedMs(rowAndRegistryLoadStart)
		return rows
	})
	const retrieversStart = performance.now()
	const retrieverRunPromise =
		input.userId && input.query && !domainFilter
			? runPackageRetrievers({
					env: input.env,
					baseUrl: input.callerContext.baseUrl,
					userId: input.userId,
					scope: 'search',
					query: input.query,
					includeHiddenPackages: input.includeHiddenPackages,
					memoryContext: resolveSearchMemoryContext({
						query: input.query,
						memoryContext: input.memoryContext,
					}),
					conversationId: input.conversationId,
				}).then((retrieverRun) => {
					phaseTimings.retrieversMs = elapsedMs(retrieversStart)
					return retrieverRun
				})
			: Promise.resolve({ results: [], warnings: [] }).then((retrieverRun) => {
					phaseTimings.retrieversMs = elapsedMs(retrieversStart)
					return retrieverRun
				})
	const [searchRows] = await Promise.all([rowsPromise, retrieverRunPromise])
	warnings = searchRows.warnings
	const retrieverRun = await retrieverRunPromise
	warnings.push(...retrieverRun.warnings)
	result = await searchUnified({
		env: input.env,
		query: input.query,
		limit: input.limit,
		userId: input.userId ?? undefined,
		registry: searchRows.registry,
		optionalRows: searchRows,
		retrieverResults: retrieverRun.results,
		...(domainFilter ? { domain: domainFilter } : {}),
	})
	capabilityGuidance = result.guidance
	const returnsDomainIndex =
		result.matches.length > 0 &&
		result.matches.every((match) => match.type === 'domain')
	const memorySettlement =
		shouldEnrichMemory &&
		(!returnsDomainIndex || Boolean(memoryContextRetrievalQuery))
			? await settleSearchMemoryEnrichment({
					promise: memoryEnrichmentPromise,
					launchedAtMs: memoryEnrichmentLaunchedAtMs,
				})
			: ({
					warnings: [],
					phaseTimings: {},
				} satisfies SearchMemoryEnrichmentSettlement)
	Object.assign(phaseTimings, memorySettlement.phaseTimings)
	warnings.push(...memorySettlement.warnings)

	return {
		result,
		username,
		warnings,
		memorySettlement,
		phaseTimings,
		...(capabilityGuidance ? { capabilityGuidance } : {}),
	}
}
