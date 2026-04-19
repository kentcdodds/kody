import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'
import { repoSessionIdSchema } from './repo-shared.ts'

const outputSchema = z.discriminatedUnion('status', [
	z.object({
		status: z.literal('ok'),
		session_id: z.string(),
		published_commit: z.string(),
		message: z.string(),
	}),
	z.object({
		status: z.literal('checks_outdated'),
		session_id: z.string(),
		published_commit: z.null(),
		message: z.string(),
	}),
	z.object({
		status: z.literal('base_moved'),
		session_id: z.string(),
		published_commit: z.null(),
		message: z.string(),
		repair_hint: z.literal('repo_rebase_session'),
		session_base_commit: z.string(),
		current_published_commit: z.string().nullable(),
	}),
])

export const repoPublishSessionCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repo_publish_session',
		description:
			'Publish an active repo session back to the source repo after checks pass on the current tree and the base commit is still current.',
		keywords: ['repo', 'publish', 'session', 'checks', 'artifact'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: repoSessionIdSchema,
		outputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const result = await repoSessionRpc(
				ctx.env,
				args.session_id,
			).publishSession({
				sessionId: args.session_id,
				userId: user.userId,
			})
			if (result.status === 'ok') {
				return {
					status: 'ok' as const,
					session_id: result.sessionId,
					published_commit: result.publishedCommit,
					message: result.message,
				}
			}
			if (result.status === 'checks_outdated') {
				return {
					status: 'checks_outdated' as const,
					session_id: result.sessionId,
					published_commit: null,
					message: result.message,
				}
			}
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
