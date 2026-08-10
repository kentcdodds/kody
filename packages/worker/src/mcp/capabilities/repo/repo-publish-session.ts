import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	buildPlainRepoPackageShapedFields,
	isPlainRepoPackageShapedAtCommit,
} from './plain-repo-package-shaped.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'
import { getEntitySourceByIdForUser } from '#worker/repo/entity-sources.ts'
import { getMcpUserPackageScope } from '#worker/package-registry/user-scope.ts'
import {
	repoPublishSessionInputSchema,
	repoPublishSessionOutputSchema,
} from './repo-shared.ts'
import { rebuildPublishedPackageArtifactsViaRepoSession } from './package-artifact-rebuild.ts'
import { reportCapabilityProgress } from '#mcp/progress.ts'

export const repoPublishSessionCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repo_publish_session',
		description:
			'Publish an active repo session back to the source repo after checks pass on the current tree and the base commit is still current. Changing package.json `"private"` requires confirm_private_visibility_change after explicit user approval.',
		keywords: ['repo', 'publish', 'session', 'checks', 'artifact'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: repoPublishSessionInputSchema,
		outputSchema: repoPublishSessionOutputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const session = repoSessionRpc(ctx.env, args.session_id)
			const sessionInfo = await session.getSessionInfo({
				sessionId: args.session_id,
				userId: user.userId,
			})
			const isPackageSession = sessionInfo.entity_type === 'package'
			const progressTotal = isPackageSession ? 3 : 2
			await reportCapabilityProgress(ctx.reportProgress, {
				progress: 1,
				total: progressTotal,
				message:
					'Running publish checks on the session tree — lint, typecheck, the works…',
			})
			const result = await session.publishSession({
				sessionId: args.session_id,
				userId: user.userId,
				rebuildPackageArtifacts: false,
				expectedPackageScope:
					sessionInfo.entity_type === 'package'
						? await getMcpUserPackageScope(ctx.env.APP_DB, user)
						: undefined,
				privateVisibilityChangeConfirmed:
					args.confirm_private_visibility_change,
			})
			if (result.status === 'ok') {
				if (isPackageSession) {
					await reportCapabilityProgress(ctx.reportProgress, {
						progress: 2,
						total: progressTotal,
						message:
							'Rebuilding published package artifacts — bundling for the big leagues…',
					})
					await rebuildPublishedPackageArtifactsViaRepoSession({
						env: ctx.env,
						rpcSessionId: args.session_id,
						repoSessionId: args.session_id,
						sourceId: sessionInfo.source_id,
						userId: user.userId,
						publishedCommit: result.publishedCommit,
						baseUrl: ctx.callerContext.baseUrl,
					})
					await reportCapabilityProgress(ctx.reportProgress, {
						progress: 3,
						total: progressTotal,
						message: 'Repo session published. Ship it.',
					})
					return {
						status: 'ok' as const,
						session_id: result.sessionId,
						published_commit: result.publishedCommit,
						message: result.message,
					}
				}
				const source = await getEntitySourceByIdForUser(ctx.env.APP_DB, {
					id: sessionInfo.source_id,
					userId: user.userId,
				})
				const packageShaped = source
					? await isPlainRepoPackageShapedAtCommit({
							env: ctx.env,
							repoId: source.repo_id,
							commit: result.publishedCommit,
						})
					: false
				const shapedFields = buildPlainRepoPackageShapedFields({
					packageShaped,
				})
				await reportCapabilityProgress(ctx.reportProgress, {
					progress: progressTotal,
					total: progressTotal,
					message: 'Repo session published. Ship it.',
				})
				return {
					status: 'ok' as const,
					session_id: result.sessionId,
					published_commit: result.publishedCommit,
					message: result.message,
					...shapedFields,
				}
			}
			if (result.status === 'checks_outdated') {
				await reportCapabilityProgress(ctx.reportProgress, {
					progress: progressTotal,
					total: progressTotal,
					message:
						'Publish checks are stale — refresh the session tree and try again.',
				})
				return {
					status: 'checks_outdated' as const,
					session_id: result.sessionId,
					published_commit: null,
					message: result.message,
				}
			}
			await reportCapabilityProgress(ctx.reportProgress, {
				progress: progressTotal,
				total: progressTotal,
				message:
					'The published base moved out from under this session — rebase, then retry.',
			})
			return {
				status: 'base_moved' as const,
				session_id: result.sessionId,
				published_commit: null,
				message: result.message,
				repair_hint: result.repairHint,
				session_base_commit: result.sessionBaseCommit,
				current_published_commit: result.currentPublishedCommit,
			}
		},
	},
)
