import { getPackageAppBaseUrl } from '#worker/app-base-url.ts'
import { resolvePublicUsername } from '#worker/identity/user-lookup.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { runPackageRetrievers } from '#worker/package-retrievers/service.ts'
import { type RemoteConnectorStatus } from '#worker/remote-connector/status.ts'

import { resolvePackageIdentitySearch } from './package-search-identity.ts'
import { buildExactPackageSearchResult, searchUnified } from './search-core.ts'
import {
	loadDownRemoteConnectorStatuses,
	loadSearchRowsAndRegistry,
} from './search-loaders.ts'
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

export { serializeRemoteConnectorStatus } from './search-loaders.ts'

export type SearchListExecutionResult = {
	result: SearchUnifiedResult
	username: string | null
	warnings: Array<string>
	remoteConnectorStatuses: Array<RemoteConnectorStatus>
	memorySettlement: SearchMemoryEnrichmentSettlement
	phaseTimings: Partial<SearchPhaseTimings>
	capabilityGuidance?: string
}

export async function executeSearchList(input: {
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
}): Promise<SearchListExecutionResult> {
	const domainFilter = input.domain?.trim() || undefined
	const username = await resolvePublicUsername({
		db: input.env.APP_DB,
		username: input.callerContext.user?.username ?? null,
		email: input.callerContext.user?.email ?? null,
	})
	const memoryLaunch = launchSearchMemoryEnrichment({
		env: input.env,
		callerContext: input.callerContext,
		conversationId: input.conversationId,
		query: input.memoryQuery,
		memoryContext: input.memoryContext,
	})
	const memoryEnrichmentPromise = memoryLaunch?.promise ?? Promise.resolve(null)
	const memoryEnrichmentLaunchedAtMs = memoryLaunch?.launchedAtMs
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
					username,
					includeHiddenPackages: input.includeHiddenPackages,
				})
			: { recognized: false as const }
	const phaseTimings: Partial<SearchPhaseTimings> = {}
	let warnings: Array<string> = []
	let result: SearchUnifiedResult
	let capabilityGuidance: string | undefined

	if (identityResolution.recognized) {
		const remoteConnectorStatusStart = performance.now()
		const remoteConnectorStatuses = await loadDownRemoteConnectorStatuses({
			env: input.env,
			callerContext: input.callerContext,
		})
		phaseTimings.remoteConnectorStatusMs = elapsedMs(remoteConnectorStatusStart)
		result = buildExactPackageSearchResult({
			env: input.env,
			query: input.query,
			match: identityResolution.match,
		})
		const memorySettlement = await settleSearchMemoryEnrichment({
			env: input.env,
			callerContext: input.callerContext,
			conversationId: input.conversationId,
			promise: memoryEnrichmentPromise,
			launchedAtMs: memoryEnrichmentLaunchedAtMs,
		})
		Object.assign(phaseTimings, memorySettlement.phaseTimings)
		warnings.push(...memorySettlement.warnings)
		return {
			result,
			username,
			warnings,
			remoteConnectorStatuses,
			memorySettlement,
			phaseTimings,
		}
	}

	const rowAndRegistryLoadStart = performance.now()
	const rowsPromise = loadSearchRowsAndRegistry({
		env: input.env,
		callerContext: input.callerContext,
		userId: input.userId,
		includeHiddenPackages: input.includeHiddenPackages,
	}).then((rows) => {
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
	const remoteConnectorStatusStart = performance.now()
	const remoteConnectorStatuses = await loadDownRemoteConnectorStatuses({
		env: input.env,
		callerContext: input.callerContext,
	})
	phaseTimings.remoteConnectorStatusMs = elapsedMs(remoteConnectorStatusStart)
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
	const memorySettlement = await settleSearchMemoryEnrichment({
		env: input.env,
		callerContext: input.callerContext,
		conversationId: input.conversationId,
		promise: memoryEnrichmentPromise,
		launchedAtMs: memoryEnrichmentLaunchedAtMs,
	})
	Object.assign(phaseTimings, memorySettlement.phaseTimings)
	warnings.push(...memorySettlement.warnings)

	return {
		result,
		username,
		warnings,
		remoteConnectorStatuses,
		memorySettlement,
		phaseTimings,
		...(capabilityGuidance ? { capabilityGuidance } : {}),
	}
}
