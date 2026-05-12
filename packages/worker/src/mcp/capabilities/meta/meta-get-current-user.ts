import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
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
			'Get harmless identity fields for the signed-in MCP user: id, email, and display name.',
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
		inputSchema: z.object({}),
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
