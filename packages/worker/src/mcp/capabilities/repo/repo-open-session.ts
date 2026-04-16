import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { getActiveRepoSessionByConversation } from '#worker/repo/repo-sessions.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import {
	repoSessionInfoSchema,
	repoOpenSessionInputSchema,
} from './repo-shared.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'

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
		outputSchema: repoSessionInfoSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = ctx.callerContext.user
			if (!user) {
				throw new Error('repo_open_session requires an authenticated user.')
			}

			const existingSession =
				args.conversation_id == null
					? null
					: await getActiveRepoSessionByConversation(ctx.env.APP_DB, {
							userId: user.userId,
							conversationId: args.conversation_id,
						})
			if (existingSession) {
				if (existingSession.source_id !== args.source_id) {
					throw new Error(
						'Active repo session does not match the requested source. Discard the current session before opening a new source.',
					)
				}
				return repoSessionRpc(ctx.env, existingSession.id).getSessionInfo({
					sessionId: existingSession.id,
				})
			}

			const source = await getEntitySourceById(ctx.env.APP_DB, args.source_id)
			if (!source || source.user_id !== user.userId) {
				throw new Error('Repo source was not found for this user.')
			}

			const sessionId =
				crypto.randomUUID?.() ??
				`repo-session-${Date.now().toString(36)}-${Math.random()
					.toString(36)
					.slice(2, 10)}`

			return repoSessionRpc(ctx.env, sessionId).openSession({
				sessionId,
				sourceId: source.id,
				userId: user.userId,
				baseUrl: ctx.callerContext.baseUrl,
				conversationId: args.conversation_id ?? null,
				sourceRoot: args.source_root ?? source.source_root,
			})
		},
	},
)
