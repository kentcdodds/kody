import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'
import {
	repoEditFilesInputSchema,
	repoEditFilesOutputSchema,
} from './repo-shared.ts'

const fileLevelApiNote =
	'This is the file-level repo session API: use `repo_rebase_session` to merge from the published default branch. There is no git-command channel; branch, checkout, and remote operations are not available in sessions (use the git lane via `package_get_git_remote` for full git).'

export const repoEditFilesCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repo_edit_files',
		description: [
			'Apply a batch of file-level edits in an active repo session: write, replace, writeJson, delete, or move.',
			fileLevelApiNote,
			'Each content-changing edit is subject to a 10 MiB per-file size limit on the planned result.',
			'Edits mutate the live session overlay only; pair with `repo_commit`, `repo_run_checks`, and `repo_publish_session` to validate and publish.',
		].join(' '),
		keywords: [
			'repo',
			'session',
			'file',
			'edit',
			'move',
			'delete',
			'write',
			'replace',
			'workspace',
		],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: repoEditFilesInputSchema,
		outputSchema: repoEditFilesOutputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const result = await repoSessionRpc(ctx.env, args.session_id).applyEdits({
				sessionId: args.session_id,
				userId: user.userId,
				edits: args.edits.map((edit) => {
					switch (edit.kind) {
						case 'write':
							return {
								kind: 'write' as const,
								path: edit.path,
								content: edit.content,
							}
						case 'replace':
							return {
								kind: 'replace' as const,
								path: edit.path,
								search: edit.search,
								replacement: edit.replacement,
								options: edit.options
									? {
											caseSensitive: edit.options.case_sensitive,
											regex: edit.options.regex,
											wholeWord: edit.options.whole_word,
											contextBefore: edit.options.context_before,
											contextAfter: edit.options.context_after,
											maxMatches: edit.options.max_matches,
											spaces: edit.options.spaces,
										}
									: undefined,
							}
						case 'writeJson':
							return {
								kind: 'writeJson' as const,
								path: edit.path,
								value: edit.value,
								options: edit.options,
							}
						case 'delete':
							return {
								kind: 'delete' as const,
								path: edit.path,
							}
						case 'move':
							return {
								kind: 'move' as const,
								path: edit.path,
								to: edit.to,
							}
						default: {
							const exhaustive: never = edit
							return exhaustive
						}
					}
				}),
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
