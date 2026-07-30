import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { assertWithinEntitlement } from '#worker/entitlements/service.ts'
import { getActiveRepoSessionByConversation } from '#worker/repo/repo-sessions.ts'
import {
	buildPublishedCommitHeadMismatchCallerMessage,
	isPublishedCommitHeadMismatchMessage,
} from '#worker/repo/source-safety-policy.ts'
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
			'Open or resume an MCP-native repo-backed editing session for a saved source artifact when editing through Kody tools instead of a local clone. Later repo capabilities can read, search, edit, validate, and publish against a mutable session branch.',
		keywords: ['repo', 'session', 'open', 'resume', 'artifact', 'source'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: repoOpenSessionInputSchema,
		outputSchema: repoOpenSessionOutputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = ctx.callerContext.user
			if (!user) {
				throw new McpCallerError(
					'repo_open_session requires an authenticated user.',
				)
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
					throw new McpCallerError(
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

			await assertWithinEntitlement({
				db: ctx.env.APP_DB,
				userId: user.userId,
				email: user.email,
				resource: 'repo_sessions',
			})

			let session
			try {
				session = await repoSessionRpc(ctx.env, sessionId).openSession({
					sessionId,
					sourceId: requested.source.id,
					userId: user.userId,
					baseUrl: ctx.callerContext.baseUrl,
					conversationId: args.conversation_id ?? null,
					sourceRoot: args.source_root ?? requested.source.source_root,
					defaultBranch: args.default_branch ?? null,
				})
			} catch (error) {
				const message = getErrorMessage(error)
				// Unpublished git-lane pushes leave HEAD ahead of published_commit
				// until package_publish_external_push (or reconcile) lands. Keep the
				// safety gate, but classify it as a caller precondition so Sentry
				// does not open platform-bug issues for expected workflow state.
				if (isPublishedCommitHeadMismatchMessage(message)) {
					throw new McpCallerError(
						buildPublishedCommitHeadMismatchCallerMessage(message),
						{ cause: error },
					)
				}
				throw error
			}
			return {
				...session,
				resolved_target: requested.resolvedTarget,
			}
		},
	},
)
