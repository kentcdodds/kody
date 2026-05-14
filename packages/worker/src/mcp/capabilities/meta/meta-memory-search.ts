import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	memorySearchMutationGuidance,
	searchMemoryRecords,
} from '#mcp/memory/service.ts'
import {
	memoryMatchSchema,
	requireMcpUser,
	verifyFirstWarning,
} from './meta-memory-shared.ts'

const mutableMemoryMatchSchema = memoryMatchSchema.extend({
	can_mutate: z.boolean(),
	mutation_guidance: z.string(),
})

export const metaMemorySearchCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'meta_memory_search',
		description:
			'Search stored memories for the signed-in user. Returned matches are mutable for this signed-in user unless can_mutate is false. If you are considering writing or deleting a memory, prefer meta_memory_verify first and review the related memories before taking action.',
		keywords: ['memory', 'search', 'lookup', 'related', 'verify'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			query: z.string().min(1).describe('Freeform memory search query.'),
			category: z
				.string()
				.min(1)
				.max(120)
				.optional()
				.describe('Optional category filter. Categories are freeform strings.'),
			limit: z
				.number()
				.int()
				.min(1)
				.max(20)
				.default(5)
				.describe('Maximum memories to return. Defaults to 5.'),
			include_deleted: z
				.boolean()
				.optional()
				.describe('Whether to include deleted memories. Defaults to false.'),
		}),
		outputSchema: z.object({
			query: z.string(),
			matches: z.array(mutableMemoryMatchSchema),
			warning: z.string(),
		}),
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const result = await searchMemoryRecords({
				env: ctx.env,
				userId: user.userId,
				query: args.query,
				category: args.category ?? null,
				limit: args.limit,
				includeDeleted: args.include_deleted ?? false,
			})
			return {
				query: args.query,
				matches: result.matches.map((match) => ({
					id: match.id,
					category: match.category,
					status: match.status,
					subject: match.subject,
					summary: match.summary,
					details: match.details,
					tags: match.tags,
					source_uris: match.sourceUris,
					dedupe_key: match.dedupeKey,
					created_at: match.createdAt,
					updated_at: match.updatedAt,
					last_accessed_at: match.lastAccessedAt,
					deleted_at: match.deletedAt,
					score: match.score,
					can_mutate: true,
					mutation_guidance: memorySearchMutationGuidance,
				})),
				warning: verifyFirstWarning,
			}
		},
	},
)
