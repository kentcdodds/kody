import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { getActiveRepoSessionByConversation } from '#worker/repo/repo-sessions.ts'
import {
	repoOpenSessionOutputSchema,
	repoOpenSessionInputSchema,
} from './repo-shared.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'
import { resolveRepoSourceReference } from './repo-resolve-target.ts'

export const repoOpenSessionCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repo_open_session',
		description:
			'Open or resume a repo-backed editing session for a saved source artifact so later repo capabilities can read, search, edit, validate, and publish against a mutable session fork.',
		keywords: ['repo', 'session', 'open', 'resume', 'artifact', 'source'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: repoOpenSessionInputSchema,
		outputSchema: repoOpenSessionOutputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = ctx.callerContext.user
			if (!user) {
				throw new Error('repo_open_session requires an authenticated user.')
			}

			const requested = await resolveRepoSourceReference({
				db: ctx.env.APP_DB,
				userId: user.userId,
				args,
			})
			const existingSession =
				args.conversation_id == null
					? null
					: await getActiveRepoSessionByConversation(ctx.env.APP_DB, {
							userId: user.userId,
							conversationId: args.conversation_id,
						})
			if (existingSession) {
				if (existingSession.source_id !== requested.source.id) {
					throw new Error(
						'Active repo session does not match the requested source. Discard the current session before opening a new source.',
					)
				}
				const session = await repoSessionRpc(
					ctx.env,
					existingSession.id,
				).getSessionInfo({
					sessionId: existingSession.id,
					userId: user.userId,
				})
				return {
					...session,
					resolved_target: requested.resolvedTarget,
				}
			}
			const sessionId =
				crypto.randomUUID?.() ??
				`repo-session-${Date.now().toString(36)}-${Math.random()
					.toString(36)
					.slice(2, 10)}`

			const session = await repoSessionRpc(ctx.env, sessionId).openSession({
				sessionId,
				sourceId: requested.source.id,
				userId: user.userId,
				baseUrl: ctx.callerContext.baseUrl,
				conversationId: args.conversation_id ?? null,
				sourceRoot: args.source_root ?? requested.source.source_root,
				defaultBranch: args.default_branch ?? null,
			})
			return {
				...session,
				resolved_target: requested.resolvedTarget,
			}
		},
	},
)
