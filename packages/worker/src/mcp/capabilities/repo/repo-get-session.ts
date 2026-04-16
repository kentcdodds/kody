import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'
import { repoSessionIdSchema, repoSessionInfoSchema } from './repo-shared.ts'

export const repoGetSessionCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repo_get_session',
		description:
			'Inspect one repo editing session by id so the model can resume work without reopening it.',
		keywords: ['repo', 'session', 'inspect', 'resume'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: repoSessionIdSchema,
		outputSchema: repoSessionInfoSchema,
		async handler(args, ctx) {
			return await repoSessionRpc(ctx.env, args.session_id).getSessionInfo({
				sessionId: args.session_id,
			})
		},
	},
)
