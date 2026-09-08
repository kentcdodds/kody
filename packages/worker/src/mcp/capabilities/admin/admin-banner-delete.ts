import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { deleteSiteBanner } from '#worker/site-banners/service.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'
import { siteBannerIdSchema } from './site-banner-shared.ts'

const inputSchema = z.object({
	id: siteBannerIdSchema.describe('Banner UUID to delete.'),
})

const outputSchema = z.object({
	deleted: z.boolean(),
	id: siteBannerIdSchema,
})

export const adminBannerDeleteCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminBannerDelete',
		description:
			'Delete one operator-owned site announcement banner and its dismissals. Admin-only.',
		keywords: ['admin', 'banner', 'announcement', 'delete', 'remove'],
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminBannerDelete',
				async () => {
					const deleted = await deleteSiteBanner(ctx.env.APP_DB, args.id)
					if (!deleted) {
						throw new Error('Banner not found.')
					}
					return { deleted: true, id: args.id }
				},
				{
					successReason: ({ id }) => `id=${id}`,
				},
			)
		},
	},
)
