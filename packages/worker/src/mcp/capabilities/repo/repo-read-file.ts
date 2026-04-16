import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'
import {
	repoReadFileInputSchema,
	repoReadFileOutputSchema,
} from './repo-shared.ts'

export const repoReadFileCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repo_read_file',
		description:
			'Read a file from the active repo session workspace. Reads the live session overlay, not just the published base commit.',
		keywords: ['repo', 'session', 'read', 'file', 'workspace'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: repoReadFileInputSchema,
		outputSchema: repoReadFileOutputSchema,
		async handler(args, ctx: CapabilityContext) {
			requireMcpUser(ctx.callerContext)
			return repoSessionRpc(ctx.env, args.session_id).readFile({
				sessionId: args.session_id,
				path: args.path,
			})
		},
	},
)
