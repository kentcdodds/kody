import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'
import { repoSessionIdSchema } from './repo-shared.ts'
import { z } from 'zod'

const outputSchema = z.object({
	ok: z.literal(true),
	session_id: z.string(),
	base_commit: z.string(),
	head_commit: z.string().nullable(),
	merged: z.boolean(),
})

export const repoRebaseSessionCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repo_rebase_session',
		description:
			'Rebase a repo session against the latest published source state when the base commit has moved.',
		keywords: ['repo', 'rebase', 'session', 'publish', 'base moved'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: repoSessionIdSchema,
		outputSchema,
		async handler(args, ctx) {
			requireMcpUser(ctx.callerContext)
			const result = await repoSessionRpc(
				ctx.env,
				args.session_id,
			).rebaseSession({
				sessionId: args.session_id,
			})
			return {
				ok: result.ok,
				session_id: result.sessionId,
				base_commit: result.baseCommit,
				head_commit: result.headCommit ?? null,
				merged: result.merged,
			}
		},
	},
)
