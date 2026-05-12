import { type z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'
import { getMcpUserPackageScope } from '#worker/package-registry/user-scope.ts'
import { resolveRepoTargetFromSource } from './repo-resolve-target.ts'
import { repoRunCommandsCapabilityDescription } from './repo-run-commands-text.ts'
import {
	normalizeRepoCommandChecks,
	normalizeRepoCommandPublish,
	repoOpenSessionOutputSchema,
	repoRunCommandsInputSchema,
	repoRunCommandsOutputSchema,
} from './repo-shared.ts'
import { repoOpenSessionCapability } from './repo-open-session.ts'
import { rebuildPublishedPackageArtifactsViaRepoSession } from './package-artifact-rebuild.ts'

type RepoRunCommandsOutput = z.infer<typeof repoRunCommandsOutputSchema>

async function loadRepoCommandSession(input: {
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

export const repoRunCommandsCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repo_run_commands',
		description: repoRunCommandsCapabilityDescription,
		keywords: [
			'repo',
			'git',
			'commands',
			'artifact',
			'edit',
			'checks',
			'publish',
		],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: repoRunCommandsInputSchema,
		outputSchema: repoRunCommandsOutputSchema,
		async handler(args, ctx): Promise<RepoRunCommandsOutput> {
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
					: await loadRepoCommandSession({
							env: ctx.env,
							userId: user.userId,
							sessionId: args.session_id,
						})
			const validatedSession = repoOpenSessionOutputSchema.parse(session)
			const sessionRpc = repoSessionRpc(ctx.env, validatedSession.id)
			const expectedPackageScope =
				validatedSession.entity_type === 'package' && args.run_checks === true
					? await getMcpUserPackageScope(ctx.env.APP_DB, user)
					: undefined
			const result = await sessionRpc.runCommands({
				sessionId: validatedSession.id,
				userId: user.userId,
				commands: args.commands,
				dryRun: args.dry_run,
				runChecks: args.run_checks,
				publish: false,
				expectedPackageScope,
			})
			let publish = result.publish
			if (args.publish === true) {
				if (result.checks.status === 'failed') {
					publish = {
						status: 'blocked_by_checks' as const,
						message: 'Publishing skipped because repo checks failed.',
						failedChecks: result.checks.failedChecks,
						runId: result.checks.runId,
						treeHash: result.checks.treeHash,
						checkedAt: result.checks.checkedAt,
					}
				} else if (result.checks.status === 'passed') {
					publish = await sessionRpc.publishSession({
						sessionId: validatedSession.id,
						userId: user.userId,
						rebuildPackageArtifacts: false,
						expectedPackageScope,
					})
				} else {
					publish = { status: 'not_requested' as const }
				}
			}
			if (
				args.publish === true &&
				publish.status === 'ok' &&
				validatedSession.entity_type === 'package'
			) {
				await rebuildPublishedPackageArtifactsViaRepoSession({
					env: ctx.env,
					rpcSessionId: validatedSession.id,
					repoSessionId: validatedSession.id,
					sourceId: validatedSession.source_id,
					userId: user.userId,
					publishedCommit: publish.publishedCommit,
					baseUrl: ctx.callerContext.baseUrl,
				})
			}
			const responseSession =
				args.publish === true && publish.status === 'ok'
					? await sessionRpc.getSessionInfo({
							sessionId: validatedSession.id,
							userId: user.userId,
						})
					: result.session
			return {
				session: responseSession,
				resolved_target: validatedSession.resolved_target,
				commands: result.commands,
				checks: normalizeRepoCommandChecks(result.checks),
				publish: normalizeRepoCommandPublish(publish),
			}
		},
	},
)
