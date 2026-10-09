import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	emptyCapabilityInputSchema,
	type CapabilityContext,
} from '#mcp/capabilities/types.ts'
import { getMcpUserPackageScope } from '#worker/package-registry/user-scope.ts'
import { requireMcpRequest, requireMcpUser } from './require-user.ts'

const outputSchema = z.object({
	user_id: z.string(),
	username: z.string(),
	email: z.email(),
	display_name: z.string(),
	org: z.object({
		slug: z.string().describe('Package scope and package-app subdomain.'),
	}),
})

export const metaGetCurrentUserCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'metaGetCurrentUser',
		orgPermission: 'none',
		description:
			'Get harmless identity fields for the signed-in MCP user: id, username, email, display name, and the slug of the org this request acts in. Use email and display_name as git user.email / user.name on Kody remotes when a git-remote result is not already in hand.',
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
			const request = requireMcpRequest(ctx.callerContext)
			const username =
				request.actor?.username ??
				(await getMcpUserPackageScope(ctx.env.APP_DB, user))
			return {
				user_id: user.userId,
				username,
				email: user.email,
				display_name: user.displayName,
				org: { slug: request.org.slug ?? username },
			}
		},
	},
)
