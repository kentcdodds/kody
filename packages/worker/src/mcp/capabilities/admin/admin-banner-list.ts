import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	emptyCapabilityInputSchema,
	type CapabilityContext,
} from '#mcp/capabilities/types.ts'
import { listSiteBannersForAdmin } from '#worker/site-banners/service.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'
import { siteBannerRecordSchema } from './site-banner-shared.ts'

const outputSchema = z.object({
	banners: z.array(siteBannerRecordSchema),
})

export const adminBannerListCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminBannerList',
		description:
			'List operator-owned site announcement banners, including targeting, audience, look, and dismiss settings. Admin-only; never returns user content beyond stored targeting ids.',
		keywords: [
			'admin',
			'banner',
			'announcement',
			'launch',
			'site banner',
			'promo',
		],
		inputSchema: emptyCapabilityInputSchema,
		outputSchema,
		async handler(_args, ctx: CapabilityContext) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminBannerList',
				async () => ({
					banners: await listSiteBannersForAdmin(ctx.env.APP_DB),
				}),
				{
					successReason: ({ banners }) => `count=${String(banners.length)}`,
				},
			)
		},
	},
)
