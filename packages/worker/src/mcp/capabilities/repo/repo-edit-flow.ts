import { type z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'
import { toRepoSessionEdit } from './repo-patch-instruction.ts'
import { resolveRepoTargetFromSource } from './repo-resolve-target.ts'
import {
	repoEditFlowInputSchema,
	repoEditFlowOutputSchema,
	repoOpenSessionOutputSchema,
} from './repo-shared.ts'
import { repoOpenSessionCapability } from './repo-open-session.ts'

type RepoEditFlowResult = z.infer<typeof repoEditFlowOutputSchema>

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
				edits: args.instructions.map((instruction) =>
					toRepoSessionEdit(instruction),
				),
				rollbackOnError: args.rollback_on_error,
			})
			const editsSummary = {
				dry_run: edits.dryRun,
				total_changed: edits.totalChanged,
				edits: edits.edits,
			}
			const buildFlowResponse = async (
				checks: RepoEditFlowResult['checks'],
				publish: RepoEditFlowResult['publish'],
			) => {
				const currentSession = await loadRepoEditFlowSession({
					env: ctx.env,
					userId: user.userId,
					sessionId: validatedSession.id,
				})
				return {
					session: currentSession,
					resolved_target: currentSession.resolved_target,
					edits: editsSummary,
					checks,
					publish,
				}
			}

			const shouldRunChecks = args.run_checks ?? true
			const shouldPublish = args.publish ?? shouldRunChecks

			if (!shouldRunChecks) {
				return buildFlowResponse(
					{
						status: 'not_requested' as const,
					},
					{
						status: 'not_requested' as const,
					},
				)
			}

			const checkRun = await rpc.runChecks({
				sessionId: validatedSession.id,
				userId: user.userId,
			})
			if (!checkRun.ok) {
				const failedChecks = checkRun.results.filter((entry) => !entry.ok)
				return buildFlowResponse(
					{
						status: 'failed' as const,
						ok: false as const,
						results: checkRun.results,
						failed_checks: failedChecks,
						manifest: checkRun.manifest,
						run_id: checkRun.runId,
						tree_hash: checkRun.treeHash,
						checked_at: checkRun.checkedAt,
					},
					shouldPublish
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
				)
			}

			if (!shouldPublish) {
				return buildFlowResponse(
					{
						status: 'passed' as const,
						ok: true as const,
						results: checkRun.results,
						manifest: checkRun.manifest,
						run_id: checkRun.runId,
						tree_hash: checkRun.treeHash,
						checked_at: checkRun.checkedAt,
					},
					{
						status: 'not_requested' as const,
					},
				)
			}

			const publish = await rpc.publishSession({
				sessionId: validatedSession.id,
				userId: user.userId,
			})
			switch (publish.status) {
				case 'ok': {
					return buildFlowResponse(
						{
							status: 'passed' as const,
							ok: true as const,
							results: checkRun.results,
							manifest: checkRun.manifest,
							run_id: checkRun.runId,
							tree_hash: checkRun.treeHash,
							checked_at: checkRun.checkedAt,
						},
						{
							status: 'published' as const,
							session_id: publish.sessionId,
							published_commit: publish.publishedCommit,
							message: publish.message,
						},
					)
				}
				case 'checks_outdated': {
					return buildFlowResponse(
						{
							status: 'passed' as const,
							ok: true as const,
							results: checkRun.results,
							manifest: checkRun.manifest,
							run_id: checkRun.runId,
							tree_hash: checkRun.treeHash,
							checked_at: checkRun.checkedAt,
						},
						{
							status: 'checks_outdated' as const,
							session_id: publish.sessionId,
							published_commit: null,
							message: publish.message,
						},
					)
				}
				case 'base_moved': {
					return buildFlowResponse(
						{
							status: 'passed' as const,
							ok: true as const,
							results: checkRun.results,
							manifest: checkRun.manifest,
							run_id: checkRun.runId,
							tree_hash: checkRun.treeHash,
							checked_at: checkRun.checkedAt,
						},
						{
							status: 'base_moved' as const,
							session_id: publish.sessionId,
							published_commit: null,
							message: publish.message,
							repair_hint: publish.repairHint,
							session_base_commit: publish.sessionBaseCommit,
							current_published_commit: publish.currentPublishedCommit,
						},
					)
				}
				default: {
					const exhaustiveCheck: never = publish
					return exhaustiveCheck
				}
			}
		},
	},
)
