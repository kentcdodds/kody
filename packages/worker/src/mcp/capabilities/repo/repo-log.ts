import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'
import { repoLogInputSchema, repoLogOutputSchema } from './repo-shared.ts'

const fileLevelApiNote =
	'This is the file-level repo session API: use `repo_rebase_session` to merge from the published default branch. There is no git-command channel; branch, checkout, and remote operations are not available in sessions (use the git lane via `package_get_git_remote` for full git).'

export const repoLogCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repo_log',
		description: [
			'Return git commit history for the active repo session workspace.',
			fileLevelApiNote,
		].join(' '),
		keywords: ['repo', 'session', 'log', 'history', 'commit'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: repoLogInputSchema,
		outputSchema: repoLogOutputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const log = await repoSessionRpc(ctx.env, args.session_id).sessionLog({
				sessionId: args.session_id,
				userId: user.userId,
				depth: args.depth,
			})
			return { log }
		},
	},
)
