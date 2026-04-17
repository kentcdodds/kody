import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'
import {
	repoApplyPatchInputSchema,
	repoApplyPatchResultSchema,
} from './repo-shared.ts'

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
		inputSchema: repoApplyPatchInputSchema,
		outputSchema: repoApplyPatchResultSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const result = await repoSessionRpc(ctx.env, args.session_id).applyEdits({
				sessionId: args.session_id,
				userId: user.userId,
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
