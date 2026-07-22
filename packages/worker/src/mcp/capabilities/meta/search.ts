import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
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
// Domain browsing (domain without query) deliberately lists the whole domain
// by default instead of cutting at the ranked default.
const domainBrowseDefaultLimit = 100

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

function normalizeLimit(
	limit: number | undefined,
	fallback = defaultSearchLimit,
) {
	if (!limit) return fallback
	return Math.max(1, Math.min(Math.floor(limit), maxSearchLimit))
}

export const searchCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'search',
		description:
			'Search Kody capabilities, saved packages, values, integrations, and secret references using natural language or exact user-scoped package identity. Pass "domain" to rank only one capability domain. Use this inside package and execute runtimes when reusable code needs the same discovery surface as the public MCP search tool.',
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
				.optional()
				.describe(
					'Natural language description, or an exact saved-package UUID, kody id, current-origin account package URL, or owner-matching hosted package URL. Optional when "domain" is provided.',
				),
			domain: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Optional capability domain id (for example "email" or "remote:home"). With "query", ranks only that domain\'s capabilities; without "query", lists the domain\'s capabilities.',
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
				query?: string
				domain?: string
				limit?: number
				conversationId?: string
				memoryContext?: z.infer<typeof memoryContextInputField>
				includeHiddenPackages?: boolean
			},
			ctx: CapabilityContext,
		) {
			const query = args.query?.trim() ?? ''
			const domainFilter = args.domain?.trim() || undefined
			if (!query && !domainFilter) {
				throw new Error('Provide "query" or "domain".')
			}
			const conversationId = resolveConversationId(args.conversationId)
			const userId = ctx.callerContext.user?.userId ?? null
			const includeHiddenPackages = !!args.includeHiddenPackages
			// Deliberately dynamic: search-execution loads the capability registry,
			// which includes this meta capability.
			const { executeSearchList, serializeRemoteConnectorStatus } =
				await import('#mcp/tools/search-execution.ts')
			const execution = await executeSearchList({
				env: ctx.env,
				callerContext: ctx.callerContext,
				conversationId,
				query,
				...(args.query !== undefined ? { memoryQuery: args.query } : {}),
				limit: normalizeLimit(
					args.limit,
					domainFilter && !query ? domainBrowseDefaultLimit : undefined,
				),
				userId,
				includeHiddenPackages,
				memoryContext: args.memoryContext,
				...(domainFilter ? { domain: domainFilter } : {}),
			})
			return {
				conversationId,
				matches: toSlimStructuredMatches({
					matches: execution.result.matches,
					baseUrl: ctx.callerContext.baseUrl,
					username: execution.username,
				}) as Array<SlimSearchMatch>,
				offline: execution.result.offline,
				warnings: execution.warnings,
				...(execution.capabilityGuidance
					? { guidance: execution.capabilityGuidance }
					: {}),
				...(execution.memorySettlement.memories
					? {
							memories: execution.memorySettlement.memories,
						}
					: {}),
				...(execution.remoteConnectorStatuses.length > 0
					? {
							remoteConnectorStatuses: execution.remoteConnectorStatuses.map(
								serializeRemoteConnectorStatus,
							),
						}
					: {}),
			}
		},
	},
)
