import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { upsertMemory } from '#mcp/memory/service.ts'
import {
	memoryRecordSchema,
	memoryTagInputSchema,
} from '#mcp/capabilities/meta/meta-memory-shared.ts'
import { requireMcpUser } from './require-user.ts'

const inputSchema = z.object({
	memory_id: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Optional existing memory id to update. Omit this field to create a new memory record.',
		),
	category: z
		.string()
		.max(80)
		.optional()
		.describe(
			'Optional freeform category string. Suggested examples include preference, profile, workflow, relationship, or identifier.',
		),
	subject: z
		.string()
		.min(1)
		.max(200)
		.describe('Short durable subject/title for the memory.'),
	summary: z
		.string()
		.min(1)
		.max(500)
		.describe('Compact durable memory summary.'),
	details: z
		.string()
		.max(2_000)
		.optional()
		.describe('Optional additional durable detail for the memory record.'),
	tags: z
		.array(memoryTagInputSchema)
		.max(12)
		.optional()
		.describe('Optional tags for retrieval and filtering.'),
	dedupe_key: z
		.string()
		.max(160)
		.optional()
		.describe('Optional stable dedupe key supplied by the agent.'),
	status: z
		.enum(['active', 'archived'])
		.optional()
		.describe('Optional non-deleted status for the memory. Defaults to active.'),
	verified_by_agent: z
		.boolean()
		.describe(
			'Must be true when writing memory. Agents must run meta_memory_verify first and then decide whether to upsert.',
		),
	verification_reference: z
		.string()
		.max(200)
		.optional()
		.describe(
			'Optional agent-supplied note, run id, or verification reference describing the verify step that preceded this upsert.',
		),
})

const outputSchema = z.object({
	mode: z.enum(['created', 'updated']),
	memory: memoryRecordSchema,
	warnings: z.array(z.string()),
})

export const metaMemoryUpsertCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'meta_memory_upsert',
		description:
			'Create a new memory when `memory_id` is omitted, or update an existing memory when `memory_id` is provided. Agents must run `meta_memory_verify` first and decide the next action themselves. Do not blindly write durable memory without verification.',
		keywords: [
			'memory',
			'upsert',
			'create',
			'update',
			'verify-first',
			'long-term memory',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			if (!args.verified_by_agent) {
				throw new Error(
					'Agents must run meta_memory_verify before calling meta_memory_upsert. Set verified_by_agent=true only after review.',
				)
			}
			const result = await upsertMemory({
				env: ctx.env,
				userId: user.userId,
				memoryId: args.memory_id ?? null,
				category: args.category ?? null,
				subject: args.subject,
				summary: args.summary,
				details: args.details ?? '',
				tags: args.tags ?? [],
				dedupeKey: args.dedupe_key ?? null,
				status: args.status ?? 'active',
				verificationReference: args.verification_reference ?? null,
			})
			return {
				mode: result.mode,
				memory: {
					id: result.memory.id,
					category: result.memory.category,
					status: result.memory.status,
					subject: result.memory.subject,
					summary: result.memory.summary,
					details: result.memory.details,
					tags: result.memory.tags,
					dedupe_key: result.memory.dedupeKey,
					created_at: result.memory.createdAt,
					updated_at: result.memory.updatedAt,
					last_accessed_at: result.memory.lastAccessedAt,
					deleted_at: result.memory.deletedAt,
				},
				warnings: result.warnings,
			}
		},
	},
)
