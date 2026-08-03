import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'
import {
	repoApplyPatchInputSchema,
	repoApplyPatchOutputSchema,
} from './repo-shared.ts'

const fileLevelApiNote =
	'This is the file-level repo session API: use `repo_rebase_session` to merge from the published default branch. There is no git-command channel; branch, checkout, and remote operations are not available in sessions (use the git lane via `package_get_git_remote` for full git).'

export const repoApplyPatchCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repo_apply_patch',
		description: [
			'Apply a unified-diff patch to the active repo session workspace.',
			fileLevelApiNote,
			'Patch application is all-or-nothing across files in the patch set and subject to the 10 MiB per-file limit on patched results.',
		].join(' '),
		keywords: ['repo', 'session', 'patch', 'apply', 'diff', 'edit', 'file'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: repoApplyPatchInputSchema,
		outputSchema: repoApplyPatchOutputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const result = await repoSessionRpc(ctx.env, args.session_id).applyPatch({
				sessionId: args.session_id,
				userId: user.userId,
				patch: args.patch,
				dryRun: args.dry_run,
			})
			return {
				dry_run: result.dryRun,
				total_changed: result.totalChanged,
				edits: result.edits.map((edit) => ({
					path: edit.path,
					changed: edit.changed,
					content: edit.content,
					diff: edit.diff,
				})),
			}
		},
	},
)
