import { personalOrgId } from '@kody-internal/shared/owner-person-ids.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { authorizeRepoSessionPackageWrite } from './authorize-repo-session-package-write.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-rpc.ts'
import {
	repoSessionIdSchema,
	repoDiscardSessionOutputSchema,
} from './repo-shared.ts'

export const repoDiscardSessionCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repoDiscardSession',
		orgPermission: 'package:write',
		description:
			'Discard a repo editing session and delete its tracked workspace state.',
		keywords: ['repo', 'session', 'discard', 'delete', 'close'],
		readOnly: false,
		idempotent: true,
		destructive: true,
		inputSchema: repoSessionIdSchema,
		outputSchema: repoDiscardSessionOutputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			await authorizeRepoSessionPackageWrite({
				env: ctx.env,
				request: ctx.callerContext.request,
				userId: personalOrgId(user.userId),
				sessionId: args.session_id,
				allowMissingSession: true,
			})
			const result = await repoSessionRpc(
				ctx.env,
				args.session_id,
			).discardSession({
				sessionId: args.session_id,
				userId: personalOrgId(user.userId),
			})
			return {
				ok: true as const,
				session_id: result.sessionId,
				deleted: result.deleted,
			}
		},
	},
)
