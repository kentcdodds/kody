import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { getMemory } from '#mcp/memory/service.ts'
import { memoryRecordSchema } from './meta-memory-shared.ts'
import { requireMcpUser } from './require-user.ts'

export const metaMemoryGetCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'meta_memory_get',
		description: 'Load one stored durable memory by id for the signed-in user.',
		keywords: ['memory', 'get', 'load', 'read', 'durable memory'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			memory_id: z.string().min(1).describe('Stored memory id to load.'),
		}),
		outputSchema: memoryRecordSchema.nullable(),
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const memory = await getMemory({
				env: ctx.env,
				userId: user.userId,
				memoryId: args.memory_id,
			})
			return memory
				? {
						id: memory.id,
						category: memory.category,
						status: memory.status,
						subject: memory.subject,
						summary: memory.summary,
						details: memory.details,
						tags: memory.tags,
						dedupe_key: memory.dedupeKey,
						created_at: memory.createdAt,
						updated_at: memory.updatedAt,
						last_accessed_at: memory.lastAccessedAt,
						deleted_at: memory.deletedAt,
					}
				: null
		},
	},
)
