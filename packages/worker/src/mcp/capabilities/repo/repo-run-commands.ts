import { type z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'
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
			const result = await repoSessionRpc(
				ctx.env,
				validatedSession.id,
			).runCommands({
				sessionId: validatedSession.id,
				userId: user.userId,
				commands: args.commands,
				dryRun: args.dry_run,
				runChecks: args.run_checks,
				publish: args.publish,
			})
			return {
				session: result.session,
				resolved_target: validatedSession.resolved_target,
				commands: result.commands,
				checks: normalizeRepoCommandChecks(result.checks),
				publish: normalizeRepoCommandPublish(result.publish),
			}
		},
	},
)
