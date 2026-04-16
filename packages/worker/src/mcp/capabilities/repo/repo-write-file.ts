import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'
import {
	repoWriteFileInputSchema,
	repoWriteFileOutputSchema,
} from './repo-shared.ts'

export const repoWriteFileCapability = defineDomainCapability(
	capabilityDomainNames.repo,
	{
		name: 'repo_write_file',
		description:
			'Write the full contents of one file inside an active repo session.',
		keywords: ['repo', 'session', 'write', 'file', 'edit'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: repoWriteFileInputSchema,
		outputSchema: repoWriteFileOutputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			void user
			return await repoSessionRpc(ctx.env, args.session_id).writeFile({
				sessionId: args.session_id,
				path: args.path,
				content: args.content,
			})
		},
	},
)
