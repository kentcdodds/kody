import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'
import {
	repoSessionIdSchema,
	repoDiscardSessionOutputSchema,
} from './repo-shared.ts'

export const repoDiscardSessionCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repo_discard_session',
		description:
			'Discard a repo editing session and delete its tracked workspace state.',
		keywords: ['repo', 'session', 'discard', 'delete', 'close'],
		readOnly: false,
		idempotent: true,
		destructive: true,
		inputSchema: repoSessionIdSchema,
		outputSchema: repoDiscardSessionOutputSchema,
		async handler(args, ctx) {
			requireMcpUser(ctx.callerContext)
			const result = await repoSessionRpc(
				ctx.env,
				args.session_id,
			).discardSession({
				sessionId: args.session_id,
			})
			return {
				ok: true as const,
				session_id: result.sessionId,
				deleted: result.deleted,
			}
		},
	},
)
