import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { deletePlatformOauthApp } from '#worker/integrations/platform-apps.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const inputSchema = z
	.object({
		slug: z.string().min(1).describe('Platform OAuth app slug to delete.'),
	})
	.strict()

const outputSchema = z.object({
	deleted: z.boolean(),
})

export const adminPlatformOauthAppDeleteCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'admin_platform_oauth_app_delete',
		description:
			'Delete a platform (built-in) OAuth app. Fails while user connections still reference it — disable the app instead when users are connected. Admin-only.',
		keywords: [
			'admin',
			'platform',
			'oauth',
			'app',
			'built-in',
			'integration',
			'delete',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'admin_platform_oauth_app_delete',
				async () => ({
					deleted: await deletePlatformOauthApp({
						db: ctx.env.APP_DB,
						slug: args.slug,
					}),
				}),
				{
					successReason: () => `platform_oauth_app=${args.slug.trim()}`,
				},
			)
		},
	},
)
