import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'

const repoPatchSearchOptionsSchema = z.object({
	case_sensitive: z.boolean().optional(),
	regex: z.boolean().optional(),
	whole_word: z.boolean().optional(),
	context_before: z.number().int().min(0).optional(),
	context_after: z.number().int().min(0).optional(),
	max_matches: z.number().int().min(1).optional(),
})

const repoPatchInstructionSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('write'),
		path: z.string().min(1),
		content: z.string(),
	}),
	z.object({
		kind: z.literal('replace'),
		path: z.string().min(1),
		search: z.string().min(1),
		replacement: z.string(),
		options: repoPatchSearchOptionsSchema.optional(),
	}),
	z.object({
		kind: z.literal('write_json'),
		path: z.string().min(1),
		value: z.unknown(),
		spaces: z.number().int().min(0).optional(),
	}),
])

const inputSchema = z.object({
	session_id: z.string().min(1),
	instructions: z.array(repoPatchInstructionSchema).min(1),
	dry_run: z.boolean().optional(),
	rollback_on_error: z.boolean().optional(),
})

const outputSchema = z.object({
	dry_run: z.boolean(),
	edits: z.array(
		z.object({
			path: z.string(),
			changed: z.boolean(),
			content: z.string(),
			diff: z.string(),
		}),
	),
	total_changed: z.number().int().min(0),
})

export const repoApplyPatchCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repo_apply_patch',
		description:
			'Apply one or more structured file edits transactionally inside an active repo session.',
		keywords: ['repo', 'patch', 'edit', 'replace', 'write', 'transactional'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			requireMcpUser(ctx.callerContext)
			const result = await repoSessionRpc(ctx.env, args.session_id).applyEdits({
				sessionId: args.session_id,
				edits: args.instructions.map((instruction) => {
					switch (instruction.kind) {
						case 'write':
							return instruction
						case 'replace':
							return {
								kind: 'replace' as const,
								path: instruction.path,
								search: instruction.search,
								replacement: instruction.replacement,
								options:
									instruction.options == null
										? undefined
										: {
												caseSensitive: instruction.options.case_sensitive,
												regex: instruction.options.regex,
												wholeWord: instruction.options.whole_word,
												contextBefore: instruction.options.context_before,
												contextAfter: instruction.options.context_after,
												maxMatches: instruction.options.max_matches,
											},
							}
						case 'write_json':
							return {
								kind: 'writeJson' as const,
								path: instruction.path,
								value: instruction.value,
								options:
									instruction.spaces == null
										? undefined
										: { spaces: instruction.spaces },
							}
					}
				}),
				dryRun: args.dry_run,
				rollbackOnError: args.rollback_on_error,
			})
			return {
				dry_run: result.dryRun,
				edits: result.edits,
				total_changed: result.totalChanged,
			}
		},
	},
)
