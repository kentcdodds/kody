import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'
import {
	repoWriteFileInputSchema,
	repoWriteFileOutputSchema,
} from './repo-shared.ts'

export const repoWriteFileCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repo_write_file',
		description: [
			'Overwrite one or more files in the active repo session with exact full-file content.',
			'Use this for whole-file replacements or for creating new files when crafting a unified diff for `repo_run_commands` `git apply` would be brittle (for example, single-file job sources or generated package modules).',
			'Each entry replaces the file at `path` with `content` exactly; missing parent directories are created. Returns a per-file diff plus a `changed` flag for callers that want to confirm a write actually mutated the workspace.',
			'Writes only mutate the live session overlay; they do not commit, run checks, or publish. Pair with `repo_run_commands` for `git add`/`git commit` and with `repo_publish_session` (or `repo_run_commands` with `publish: true`) to publish.',
		].join(' '),
		keywords: [
			'repo',
			'session',
			'write',
			'file',
			'edit',
			'replace',
			'overwrite',
			'workspace',
		],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: repoWriteFileInputSchema,
		outputSchema: repoWriteFileOutputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const result = await repoSessionRpc(ctx.env, args.session_id).applyEdits({
				sessionId: args.session_id,
				userId: user.userId,
				edits: args.files.map((file) => ({
					kind: 'write' as const,
					path: file.path,
					content: file.content,
				})),
				dryRun: args.dry_run,
				rollbackOnError: args.rollback_on_error,
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
