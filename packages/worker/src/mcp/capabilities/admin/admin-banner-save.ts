import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { parseSiteBannerInput } from '#universal/site-banners.ts'
import { saveSiteBanner } from '#worker/site-banners/service.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'
import { resolveActingAdminUserId } from './feature-flag-shared.ts'
import {
	siteBannerRecordSchema,
	siteBannerSaveInputSchema,
} from './site-banner-shared.ts'

const outputSchema = z.object({
	banner: siteBannerRecordSchema,
})

export const adminBannerSaveCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminBannerSave',
		description:
			'Create or update one operator-owned site announcement banner. Omit id to create. Admin-only; never returns user content beyond stored targeting ids.',
		keywords: [
			'admin',
			'banner',
			'announcement',
			'save',
			'create',
			'update',
			'enable',
			'disable',
		],
		inputSchema: siteBannerSaveInputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminBannerSave',
				async () => {
					const parsed = parseSiteBannerInput(args as Record<string, unknown>)
					if (!parsed.ok) {
						throw new Error(parsed.error)
					}
					const updatedBy = await resolveActingAdminUserId(ctx)
					const banner = await saveSiteBanner(ctx.env.APP_DB, {
						banner: parsed.value,
						actorUserId: updatedBy,
					})
					return { banner }
				},
				{
					successReason: ({ banner }) =>
						`id=${banner.id};enabled=${banner.enabled};priority=${String(banner.priority)};look=${banner.look}`,
				},
			)
		},
	},
)
