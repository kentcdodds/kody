import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { deleteOauthAppWithConnections } from '#worker/integrations/service.ts'

const inputSchema = z.object({
	slug: z
		.string()
		.min(1)
		.describe(
			'User-lane OAuth app slug to delete, including every connection.',
		),
})

const outputSchema = z.object({
	deleted: z.boolean(),
	connectionNames: z.array(z.string()),
})

export const integrationOauthAppDeleteCapability = defineDomainCapability(
	capabilityDomainNames.integrations,
	{
		name: 'integration_oauth_app_delete',
		description:
			'Delete a user-registered OAuth app and every connection on it. Built-in (platform) apps cannot be deleted this way — disconnect their connections with integration_delete instead.',
		keywords: ['integration', 'oauth', 'app', 'delete', 'remove', 'connection'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			return deleteOauthAppWithConnections({
				env: ctx.env,
				userId: user.userId,
				slug: args.slug,
			})
		},
	},
)
