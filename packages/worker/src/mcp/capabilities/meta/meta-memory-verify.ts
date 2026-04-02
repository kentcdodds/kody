import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { verifyMemoryCandidate } from '#mcp/memory/service.ts'
import {
	memoryMatchSchema,
	verifyCandidateInputSchema,
	requireMcpUser,
	verifyFirstGuidance,
} from './meta-memory-shared.ts'

const recommendedActions: Array<
	'upsert' | 'delete' | 'upsert_and_delete' | 'none'
> = ['upsert', 'delete', 'upsert_and_delete', 'none']

const outputSchema = z.object({
	candidate: z.object({
		subject: z.string(),
		summary: z.string(),
		details: z.string(),
		category: z.string().nullable(),
		tags: z.array(z.string()),
		dedupe_key: z.string().nullable(),
	}),
	related_memories: z.array(memoryMatchSchema),
	guidance: z.string(),
	recommended_actions: z.array(
		z.enum(['upsert', 'delete', 'upsert_and_delete', 'none']),
	),
})

export const metaMemoryVerifyCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'meta_memory_verify',
		description:
			'Always run this capability before writing or deleting memory. Submit the candidate memory, review the related memories returned here, then decide whether to upsert, delete, both, or do nothing. Do not upsert memory blindly.',
		keywords: ['memory', 'verify', 'related memories', 'dedupe', 'search'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: verifyCandidateInputSchema.extend({
			limit: z
				.number()
				.int()
				.min(1)
				.max(20)
				.optional()
				.describe('Maximum related memories to return. Defaults to 5.'),
			conversation_id: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Optional conversation id for suppression-aware verification.',
				),
			include_suppressed_in_conversation: z
				.boolean()
				.optional()
				.describe(
					'When true, include memories already surfaced in this conversation.',
				),
		}),
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const result = await verifyMemoryCandidate({
				env: ctx.env,
				userId: user.userId,
				candidate: {
					category: args.category ?? null,
					subject: args.subject,
					summary: args.summary,
					details: args.details ?? null,
					tags: args.tags ?? null,
					dedupeKey: args.dedupe_key ?? null,
				},
				limit: args.limit,
				conversationId: args.conversation_id ?? null,
				includeSuppressedInConversation:
					args.include_suppressed_in_conversation ?? false,
			})
			return {
				candidate: result.candidate,
				related_memories: result.relatedMemories.map((match) =>
					formatMemoryMatch(match.memory, match.score),
				),
				guidance: verifyFirstGuidance,
				recommended_actions: recommendedActions,
			}
		},
	},
)

function formatMemoryMatch(
	match: {
		id: string
		category: string | null
		status: 'active' | 'deleted' | 'archived'
		subject: string
		summary: string
		details: string
		tags: Array<string>
		dedupeKey: string | null
		createdAt: string
		updatedAt: string
		lastAccessedAt: string | null
		deletedAt: string | null
	},
	score: number,
) {
	return {
		id: match.id,
		category: match.category,
		status: match.status,
		subject: match.subject,
		summary: match.summary,
		details: match.details,
		tags: match.tags,
		dedupe_key: match.dedupeKey,
		created_at: match.createdAt,
		updated_at: match.updatedAt,
		last_accessed_at: match.lastAccessedAt,
		deleted_at: match.deletedAt,
		score,
	}
}
