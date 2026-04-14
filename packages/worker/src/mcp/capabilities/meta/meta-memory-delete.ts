import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { deleteMemory, getMemory } from '#mcp/memory/service.ts'
import {
	memoryRecordSchema,
	verifyFirstGuidance,
} from './meta-memory-shared.ts'
import { requireMcpUser } from './require-user.ts'

const outputSchema = z.object({
	ok: z.boolean(),
	force: z.boolean(),
	memory: memoryRecordSchema.nullable(),
	guidance: z.string(),
})

export const metaMemoryDeleteCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'meta_memory_delete',
		description:
			'Soft-delete a stored memory by default, or hard-delete it when `force` is true. Always run `meta_memory_verify` before deleting memory. Do not delete memory blindly. Review related memories first, decide the correct action, then delete.',
		keywords: [
			'memory',
			'delete',
			'archive',
			'verify first',
			'soft delete',
			'hard delete',
		],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: z.object({
			memory_id: z.string().min(1).describe('Target memory id to delete.'),
			force: z
				.boolean()
				.optional()
				.describe(
					'When true, permanently delete the record. Otherwise soft-delete it by setting status to deleted.',
				),
			verified_by_agent: z
				.boolean()
				.describe(
					'Agent assertion that `meta_memory_verify` was run before deletion.',
				),
			verification_reference: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Optional agent-supplied note or reference to the verification step that justified this deletion.',
				),
		}),
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			if (!args.verified_by_agent) {
				throw new Error(
					'Agents must run meta_memory_verify before calling meta_memory_delete. Set verified_by_agent=true only after review.',
				)
			}
			const existing = await getMemory({
				env: ctx.env,
				userId: user.userId,
				memoryId: args.memory_id,
			})
			if (!existing) {
				throw new Error('Memory not found for this user.')
			}
			const memory = await deleteMemory({
				env: ctx.env,
				userId: user.userId,
				memoryId: args.memory_id,
				force: args.force ?? false,
			})
			return {
				ok: true,
				force: args.force ?? false,
				memory: formatMemoryRecord(memory),
				guidance: `${verifyFirstGuidance} Use soft delete by default; reserve force=true for records that should be removed permanently.`,
			}
		},
	},
)

function formatMemoryRecord(
	memory:
		| Awaited<ReturnType<typeof deleteMemory>>
		| Awaited<ReturnType<typeof getMemory>>,
) {
	if (!memory) return null
	return {
		id: memory.id,
		category: memory.category,
		status: memory.status,
		subject: memory.subject,
		summary: memory.summary,
		details: memory.details,
		tags: memory.tags,
		source_uris: memory.sourceUris,
		dedupe_key: memory.dedupeKey,
		created_at: memory.createdAt,
		updated_at: memory.updatedAt,
		last_accessed_at: memory.lastAccessedAt,
		deleted_at: memory.deletedAt,
	}
}
