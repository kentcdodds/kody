import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	emptyCapabilityInputSchema,
	type CapabilityContext,
} from '#mcp/capabilities/types.ts'
import { requireMcpUser } from './require-user.ts'

const outputSchema = z.object({
	user_id: z.string(),
	email: z.email(),
	display_name: z.string(),
})

export const metaGetCurrentUserCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'meta_get_current_user',
		description:
			'Get harmless identity fields for the signed-in MCP user: id, email, and display name. Use email and display_name as git user.email / user.name on Kody remotes when a git-remote result is not already in hand.',
		keywords: [
			'user',
			'current user',
			'profile',
			'identity',
			'account',
			'email',
			'name',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: emptyCapabilityInputSchema,
		outputSchema,
		async handler(_args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			return {
				user_id: user.userId,
				email: user.email,
				display_name: user.displayName,
			}
		},
	},
)
