import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'
import { resolveRepoTargetFromSource } from './repo-resolve-target.ts'
import {
	repoEditFlowInputSchema,
	repoEditFlowOutputSchema,
	repoOpenSessionOutputSchema,
} from './repo-shared.ts'
import { repoOpenSessionCapability } from './repo-open-session.ts'

async function loadRepoEditFlowSession(input: {
	env: Env
	userId: string
	sessionId: string
}) {
	const session = await repoSessionRpc(
		input.env,
		input.sessionId,
	).getSessionInfo({
		sessionId: input.sessionId,
		userId: input.userId,
	})
	return repoOpenSessionOutputSchema.parse({
		...session,
		resolved_target: await resolveRepoTargetFromSource({
			db: input.env.APP_DB,
			userId: input.userId,
			sourceId: session.source_id,
		}),
	})
}

export const repoEditFlowCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repo_edit_flow',
		description:
			'Apply a structured repo edit workflow in one capability: open or reuse a repo session, apply edits, run checks, and optionally publish with structured repair details.',
		keywords: [
			'repo',
			'edit',
			'flow',
			'apply',
			'checks',
			'publish',
			'workflow',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: repoEditFlowInputSchema,
		outputSchema: repoEditFlowOutputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const session =
				args.session_id == null
					? await repoOpenSessionCapability.handler(
							{
								source_id: args.source_id,
								target: args.target,
								conversation_id: args.conversation_id,
								source_root: args.source_root,
								default_branch: args.default_branch,
							},
							ctx,
						)
					: await loadRepoEditFlowSession({
							env: ctx.env,
							userId: user.userId,
							sessionId: args.session_id,
						})
			const validatedSession = repoOpenSessionOutputSchema.parse(session)
			const rpc = repoSessionRpc(ctx.env, validatedSession.id)
			const edits = await rpc.applyEdits({
				sessionId: validatedSession.id,
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
						default: {
							const exhaustiveCheck: never = instruction
							return exhaustiveCheck
						}
					}
				}),
				rollbackOnError: args.rollback_on_error,
			})

			const shouldRunChecks = args.run_checks ?? true
			const shouldPublish = args.publish ?? shouldRunChecks

			if (!shouldRunChecks) {
				const currentSession = await loadRepoEditFlowSession({
					env: ctx.env,
					userId: user.userId,
					sessionId: validatedSession.id,
				})
				return {
					session: currentSession,
					resolved_target: currentSession.resolved_target,
					edits: {
						dry_run: edits.dryRun,
						total_changed: edits.totalChanged,
						edits: edits.edits,
					},
					checks: {
						status: 'not_requested' as const,
					},
					publish: {
						status: 'not_requested' as const,
					},
				}
			}

			const checkRun = await rpc.runChecks({
				sessionId: validatedSession.id,
				userId: user.userId,
			})
			if (!checkRun.ok) {
				const failedChecks = checkRun.results.filter((entry) => !entry.ok)
				const currentSession = await loadRepoEditFlowSession({
					env: ctx.env,
					userId: user.userId,
					sessionId: validatedSession.id,
				})
				return {
					session: currentSession,
					resolved_target: currentSession.resolved_target,
					edits: {
						dry_run: edits.dryRun,
						total_changed: edits.totalChanged,
						edits: edits.edits,
					},
					checks: {
						status: 'failed' as const,
						ok: false as const,
						results: checkRun.results,
						failed_checks: failedChecks,
						manifest: checkRun.manifest,
						run_id: checkRun.runId,
						tree_hash: checkRun.treeHash,
						checked_at: checkRun.checkedAt,
					},
					publish: shouldPublish
						? {
								status: 'blocked_by_checks' as const,
								message:
									'Publishing skipped because repo checks failed in this flow.',
								failed_checks: failedChecks,
								run_id: checkRun.runId,
								tree_hash: checkRun.treeHash,
								checked_at: checkRun.checkedAt,
							}
						: {
								status: 'not_requested' as const,
							},
				}
			}

			if (!shouldPublish) {
				const currentSession = await loadRepoEditFlowSession({
					env: ctx.env,
					userId: user.userId,
					sessionId: validatedSession.id,
				})
				return {
					session: currentSession,
					resolved_target: currentSession.resolved_target,
					edits: {
						dry_run: edits.dryRun,
						total_changed: edits.totalChanged,
						edits: edits.edits,
					},
					checks: {
						status: 'passed' as const,
						ok: true as const,
						results: checkRun.results,
						manifest: checkRun.manifest,
						run_id: checkRun.runId,
						tree_hash: checkRun.treeHash,
						checked_at: checkRun.checkedAt,
					},
					publish: {
						status: 'not_requested' as const,
					},
				}
			}

			const publish = await rpc.publishSession({
				sessionId: validatedSession.id,
				userId: user.userId,
			})
			switch (publish.status) {
				case 'ok': {
					const currentSession = await loadRepoEditFlowSession({
						env: ctx.env,
						userId: user.userId,
						sessionId: validatedSession.id,
					})
					return {
						session: currentSession,
						resolved_target: currentSession.resolved_target,
						edits: {
							dry_run: edits.dryRun,
							total_changed: edits.totalChanged,
							edits: edits.edits,
						},
						checks: {
							status: 'passed' as const,
							ok: true as const,
							results: checkRun.results,
							manifest: checkRun.manifest,
							run_id: checkRun.runId,
							tree_hash: checkRun.treeHash,
							checked_at: checkRun.checkedAt,
						},
						publish: {
							status: 'published' as const,
							session_id: publish.sessionId,
							published_commit: publish.publishedCommit,
							message: publish.message,
						},
					}
				}
				case 'checks_outdated': {
					const currentSession = await loadRepoEditFlowSession({
						env: ctx.env,
						userId: user.userId,
						sessionId: validatedSession.id,
					})
					return {
						session: currentSession,
						resolved_target: currentSession.resolved_target,
						edits: {
							dry_run: edits.dryRun,
							total_changed: edits.totalChanged,
							edits: edits.edits,
						},
						checks: {
							status: 'passed' as const,
							ok: true as const,
							results: checkRun.results,
							manifest: checkRun.manifest,
							run_id: checkRun.runId,
							tree_hash: checkRun.treeHash,
							checked_at: checkRun.checkedAt,
						},
						publish: {
							status: 'checks_outdated' as const,
							session_id: publish.sessionId,
							published_commit: null,
							message: publish.message,
						},
					}
				}
				case 'base_moved': {
					const currentSession = await loadRepoEditFlowSession({
						env: ctx.env,
						userId: user.userId,
						sessionId: validatedSession.id,
					})
					return {
						session: currentSession,
						resolved_target: currentSession.resolved_target,
						edits: {
							dry_run: edits.dryRun,
							total_changed: edits.totalChanged,
							edits: edits.edits,
						},
						checks: {
							status: 'passed' as const,
							ok: true as const,
							results: checkRun.results,
							manifest: checkRun.manifest,
							run_id: checkRun.runId,
							tree_hash: checkRun.treeHash,
							checked_at: checkRun.checkedAt,
						},
						publish: {
							status: 'base_moved' as const,
							session_id: publish.sessionId,
							published_commit: null,
							message: publish.message,
							repair_hint: publish.repairHint,
							session_base_commit: publish.sessionBaseCommit,
							current_published_commit: publish.currentPublishedCommit,
						},
					}
				}
				default: {
					const exhaustiveCheck: never = publish
					return exhaustiveCheck
				}
			}
		},
	},
)
