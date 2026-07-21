import { z } from 'zod'
import { resolvePublicUsername } from '#app/user-lookup.ts'
import { isCapabilitySearchOffline } from '#mcp/capabilities/capability-search.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { resolvePackageIdentitySearch } from '#mcp/tools/package-search-identity.ts'
import {
	type SearchMatch,
	toSlimStructuredMatches,
	type SlimSearchMatch,
} from '#mcp/tools/search-format.ts'
import {
	conversationIdInputField,
	memoryContextInputField,
	resolveConversationId,
} from '#mcp/tools/tool-call-context.ts'

const defaultSearchLimit = 15
const maxSearchLimit = 100

const remoteConnectorStatusSchema = z.object({
	connectorId: z.string(),
	state: z.string(),
	connected: z.boolean(),
	toolCount: z.number().int().nonnegative(),
})

const memoryResultSchema = z.object({
	surfaced: z.array(z.unknown()),
	suppressedCount: z.number().int().nonnegative(),
	retrievalQuery: z.string(),
	retrieverResults: z.array(z.unknown()).optional(),
	retrieverWarnings: z.array(z.string()).optional(),
})

const searchOutputSchema = z.object({
	conversationId: z.string(),
	matches: z.array(z.unknown()),
	offline: z.boolean(),
	warnings: z.array(z.string()),
	guidance: z.string().optional(),
	memories: memoryResultSchema.optional(),
	remoteConnectorStatuses: z.array(remoteConnectorStatusSchema).optional(),
})

function normalizeLimit(limit: number | undefined) {
	if (!limit) return defaultSearchLimit
	return Math.max(1, Math.min(Math.floor(limit), maxSearchLimit))
}

async function loadSearchRows(input: {
	ctx: CapabilityContext
	userId: string | null
	includeHiddenPackages: boolean
}) {
	// Deliberately dynamic: search.ts loads the capability registry, which
	// includes this meta capability.
	const { loadSearchRowsAndRegistry } = await import('#mcp/tools/search.ts')
	return await loadSearchRowsAndRegistry({
		env: input.ctx.env,
		callerContext: input.ctx.callerContext,
		userId: input.userId,
		includeHiddenPackages: input.includeHiddenPackages,
	})
}

async function runPackageRetrieverSearch(input: {
	ctx: CapabilityContext
	userId: string | null
	query: string
	conversationId: string
	includeHiddenPackages: boolean
	memoryContext?: z.infer<typeof memoryContextInputField>
}) {
	if (!input.userId || !input.query) {
		return { results: [], warnings: [] }
	}
	const { resolveSearchMemoryContext } = await import('#mcp/tools/search.ts')
	const { runPackageRetrievers } =
		await import('#worker/package-retrievers/service.ts')
	return await runPackageRetrievers({
		env: input.ctx.env,
		baseUrl: input.ctx.callerContext.baseUrl,
		userId: input.userId,
		scope: 'search',
		query: input.query,
		includeHiddenPackages: input.includeHiddenPackages,
		memoryContext: resolveSearchMemoryContext({
			query: input.query,
			memoryContext: input.memoryContext,
		}),
		conversationId: input.conversationId,
	})
}

export const searchCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'search',
		description:
			'Search Kody capabilities, saved packages, values, integrations, and secret references using natural language or exact user-scoped package identity. Use this inside package and execute runtimes when reusable code needs the same discovery surface as the public MCP search tool.',
		keywords: [
			'search',
			'discover',
			'capabilities',
			'packages',
			'values',
			'integrations',
			'secrets',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			query: z
				.string()
				.min(1)
				.describe(
					'Natural language description, or an exact saved-package UUID, kody id, current-origin account package URL, or owner-matching hosted package URL.',
				),
			limit: z
				.number()
				.int()
				.min(1)
				.max(maxSearchLimit)
				.optional()
				.describe('Max number of ranked results to return. Defaults to 15.'),
			conversationId: conversationIdInputField,
			memoryContext: memoryContextInputField,
			includeHiddenPackages: z
				.boolean()
				.optional()
				.describe(
					'Include hidden packages in search results (hidden packages are excluded by default).',
				),
		}),
		outputSchema: searchOutputSchema,
		async handler(
			args: {
				query: string
				limit?: number
				conversationId?: string
				memoryContext?: z.infer<typeof memoryContextInputField>
				includeHiddenPackages?: boolean
			},
			ctx: CapabilityContext,
		) {
			const query = args.query.trim()
			if (!query) {
				throw new Error('Search query is required.')
			}
			const conversationId = resolveConversationId(args.conversationId)
			const userId = ctx.callerContext.user?.userId ?? null
			const includeHiddenPackages = !!args.includeHiddenPackages
			const username = await resolvePublicUsername({
				db: ctx.env.APP_DB,
				username: ctx.callerContext.user?.username ?? null,
				email: ctx.callerContext.user?.email ?? null,
			})
			const identityResolution = await resolvePackageIdentitySearch({
				db: ctx.env.APP_DB,
				userId,
				query,
				baseUrl: ctx.callerContext.baseUrl,
				username,
				includeHiddenPackages,
			})
			const {
				launchSearchMemoryEnrichment,
				loadDownRemoteConnectorStatuses,
				searchUnified,
				serializeRemoteConnectorStatus,
				settleSearchMemoryEnrichment,
			} = await import('#mcp/tools/search.ts')
			let warnings: Array<string>
			let result: {
				matches: Array<SearchMatch>
				offline: boolean
				guidance?: string
			}
			const memoryLaunch = launchSearchMemoryEnrichment({
				env: ctx.env,
				callerContext: ctx.callerContext,
				conversationId,
				query,
				memoryContext: args.memoryContext,
			})
			const memoryEnrichmentPromise =
				memoryLaunch?.promise ?? Promise.resolve(null)
			const memoryEnrichmentLaunchedAtMs = memoryLaunch?.launchedAtMs
			if (identityResolution.recognized) {
				warnings = []
				result = {
					matches: identityResolution.match ? [identityResolution.match] : [],
					offline: isCapabilitySearchOffline(ctx.env),
				}
			} else {
				const [searchRows, retrieverRun] = await Promise.all([
					loadSearchRows({
						ctx,
						userId,
						includeHiddenPackages,
					}),
					runPackageRetrieverSearch({
						ctx,
						userId,
						query,
						conversationId,
						includeHiddenPackages,
						memoryContext: args.memoryContext,
					}),
				])
				result = await searchUnified({
					env: ctx.env,
					query,
					limit: normalizeLimit(args.limit),
					userId: userId ?? undefined,
					registry: searchRows.registry,
					optionalRows: searchRows,
					retrieverResults: retrieverRun.results,
				})
				warnings = [...searchRows.warnings, ...retrieverRun.warnings]
			}
			const remoteConnectorStatuses = await loadDownRemoteConnectorStatuses({
				env: ctx.env,
				callerContext: ctx.callerContext,
			})
			const memorySettlement = await settleSearchMemoryEnrichment({
				env: ctx.env,
				callerContext: ctx.callerContext,
				conversationId,
				promise: memoryEnrichmentPromise,
				launchedAtMs: memoryEnrichmentLaunchedAtMs,
			})
			warnings.push(...memorySettlement.warnings)
			return {
				conversationId,
				matches: toSlimStructuredMatches({
					matches: result.matches,
					baseUrl: ctx.callerContext.baseUrl,
					username,
				}) as Array<SlimSearchMatch>,
				offline: result.offline,
				warnings,
				...(result.guidance ? { guidance: result.guidance } : {}),
				...(memorySettlement.memories
					? {
							memories: memorySettlement.memories,
						}
					: {}),
				...(remoteConnectorStatuses.length > 0
					? {
							remoteConnectorStatuses: remoteConnectorStatuses.map(
								serializeRemoteConnectorStatus,
							),
						}
					: {}),
			}
		},
	},
)
