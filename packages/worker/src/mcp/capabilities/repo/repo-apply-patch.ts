import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'
import {
	repoApplyPatchInputSchema,
	repoApplyPatchResultSchema,
} from './repo-shared.ts'
import { toRepoSessionEdit } from './repo-patch-instruction.ts'

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
				edits: args.instructions.map(toRepoSessionEdit),
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
