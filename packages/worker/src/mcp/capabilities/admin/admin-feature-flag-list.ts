import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	emptyCapabilityInputSchema,
	type CapabilityContext,
} from '#mcp/capabilities/types.ts'
import { listFeatureFlagsForAdmin } from '#worker/feature-flags/service.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'
import { adminFeatureFlagSchema } from './feature-flag-shared.ts'

const outputSchema = z.object({
	flags: z.array(adminFeatureFlagSchema),
})

export const adminFeatureFlagListCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'admin_feature_flag_list',
		description:
			'List feature flags for admin review, including registry metadata, global state, and per-user overrides. Admin-only; never returns user content.',
		keywords: [
			'admin',
			'feature flags',
			'flags',
			'rollout',
			'overrides',
			'toggles',
		],
		inputSchema: emptyCapabilityInputSchema,
		outputSchema,
		async handler(_args, ctx: CapabilityContext) {
			return auditAdminCapabilityInvocation(
				ctx,
				'admin_feature_flag_list',
				async () => {
					const flags = await listFeatureFlagsForAdmin(ctx.env.APP_DB)
					return { flags }
				},
			)
		},
	},
)
