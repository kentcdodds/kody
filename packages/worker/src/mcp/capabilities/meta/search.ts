import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { listUserSecretsForSearch } from '#mcp/secrets/service.ts'
import { listValues } from '#mcp/values/service.ts'
import {
	toSlimStructuredMatches,
	type SlimSearchMatch,
} from '#mcp/tools/search-format.ts'
import {
	conversationIdInputField,
	memoryContextInputField,
	resolveConversationId,
} from '#mcp/tools/tool-call-context.ts'
import { loadRelevantMemoriesForTool } from '#mcp/tools/memory-tool-context.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'

const defaultSearchLimit = 15
const maxSearchLimit = 100

const remoteConnectorStatusSchema = z.object({
	connectorKind: z.string(),
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

function serializeRemoteConnectorStatus(status: {
	connectorKind: string
	connectorId?: string | null
	state: string
	connected: boolean
	toolCount: number
}) {
	return {
		connectorKind: status.connectorKind,
		connectorId: status.connectorId ?? 'unknown',
		state: status.state,
		connected: status.connected,
		toolCount: status.toolCount,
	}
}

async function loadSearchRows(input: {
	ctx: CapabilityContext
	userId: string | null
}) {
	const { env, callerContext } = input.ctx
	const { getCapabilityRegistryForContext } =
		await import('#mcp/capabilities/registry.ts')
	const { buildSavedPackageSearchRows, loadOptionalSearchRows } =
		await import('#mcp/tools/search.ts')
	const [registry, optionalRows] = await Promise.all([
		getCapabilityRegistryForContext({ env, callerContext }),
		loadOptionalSearchRows({
			userId: input.userId,
			loadPackages: async () => {
				const savedPackages = await listSavedPackagesByUserId(env.APP_DB, {
					userId: input.userId!,
				})
				return await buildSavedPackageSearchRows({
					env,
					baseUrl: callerContext.baseUrl,
					userId: input.userId!,
					records: savedPackages,
				})
			},
			loadUserSecrets: () =>
				listUserSecretsForSearch({
					env,
					userId: input.userId!,
				}),
			loadUserValues: () =>
				listValues({
					env,
					userId: input.userId!,
					storageContext: {
						sessionId: callerContext.storageContext?.sessionId ?? null,
						appId: callerContext.storageContext?.appId ?? null,
					},
				}),
		}),
	])
	return {
		registry,
		...optionalRows,
	}
}

async function runPackageRetrieverSearch(input: {
	ctx: CapabilityContext
	userId: string | null
	query: string
	conversationId: string
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
			'Search Kody kody, saved packages, values, integrations, and secret references using a natural language query. Use this inside package and execute runtimes when reusable code needs the same discovery surface as the public MCP search tool.',
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
				.describe('Natural language description of the capability you need.'),
			limit: z
				.number()
				.int()
				.min(1)
				.max(maxSearchLimit)
				.optional()
				.describe('Max number of ranked results to return. Defaults to 15.'),
			conversationId: conversationIdInputField,
			memoryContext: memoryContextInputField,
		}),
		outputSchema: searchOutputSchema,
		async handler(
			args: {
				query: string
				limit?: number
				conversationId?: string
				memoryContext?: z.infer<typeof memoryContextInputField>
			},
			ctx: CapabilityContext,
		) {
			const query = args.query.trim()
			if (!query) {
				throw new Error('Search query is required.')
			}
			const conversationId = resolveConversationId(args.conversationId)
			const userId = ctx.callerContext.user?.userId ?? null
			const [searchRows, retrieverRun] = await Promise.all([
				loadSearchRows({ ctx, userId }),
				runPackageRetrieverSearch({
					ctx,
					userId,
					query,
					conversationId,
					memoryContext: args.memoryContext,
				}),
			])
			const {
				loadDownRemoteConnectorStatuses,
				resolveSearchMemoryContext,
				searchUnified,
			} = await import('#mcp/tools/search.ts')
			const result = await searchUnified({
				env: ctx.env,
				query,
				limit: normalizeLimit(args.limit),
				registry: searchRows.registry,
				optionalRows: searchRows,
				retrieverResults: retrieverRun.results,
			})
			const remoteConnectorStatuses = await loadDownRemoteConnectorStatuses({
				env: ctx.env,
				callerContext: ctx.callerContext,
			})
			const memoryToolContext = await loadRelevantMemoriesForTool({
				env: ctx.env,
				callerContext: ctx.callerContext,
				conversationId,
				memoryContext: resolveSearchMemoryContext({
					query,
					memoryContext: args.memoryContext,
				}),
			})
			const warnings = [
				...searchRows.warnings,
				...retrieverRun.warnings,
				...(memoryToolContext?.retrieverWarnings ?? []),
			]
			return {
				conversationId,
				matches: toSlimStructuredMatches({
					matches: result.matches,
					baseUrl: ctx.callerContext.baseUrl,
				}) as Array<SlimSearchMatch>,
				offline: result.offline,
				warnings,
				...(result.guidance ? { guidance: result.guidance } : {}),
				...(memoryToolContext
					? {
							memories: {
								surfaced: memoryToolContext.memories,
								suppressedCount: memoryToolContext.suppressedCount,
								retrievalQuery: memoryToolContext.retrievalQuery,
								retrieverResults: memoryToolContext.retrieverResults,
								retrieverWarnings: memoryToolContext.retrieverWarnings,
							},
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
