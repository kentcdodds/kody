import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	listFeatureFlagsForAdmin,
	setFeatureFlagGlobalState,
} from '#worker/feature-flags/service.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'
import {
	adminFeatureFlagSchema,
	assertFeatureFlagKey,
	resolveActingAdminUserId,
} from './feature-flag-shared.ts'

const inputSchema = z.object({
	key: z.string().min(1).describe('Feature flag key from the code registry.'),
	enabled: z.boolean().describe('Whether the flag is globally enabled.'),
	rolloutPercent: z
		.number()
		.int()
		.min(0)
		.max(100)
		.nullable()
		.optional()
		.describe(
			'Optional 0–100 percentage rollout when enabled. Null or omitted means 100% of users once enabled.',
		),
	note: z
		.string()
		.optional()
		.describe('Optional operator note stored with the global flag state.'),
})

const outputSchema = z.object({
	flag: adminFeatureFlagSchema,
})

export const adminFeatureFlagSetCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'admin_feature_flag_set',
		description:
			'Set global enabled state and optional percentage rollout for one registry feature flag. Admin-only; never returns user content.',
		keywords: [
			'admin',
			'feature flags',
			'flags',
			'rollout',
			'toggle',
			'enable',
			'disable',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			return auditAdminCapabilityInvocation(
				ctx,
				'admin_feature_flag_set',
				async () => {
					const key = assertFeatureFlagKey(args.key)
					const updatedBy = await resolveActingAdminUserId(ctx)
					await setFeatureFlagGlobalState(ctx.env.APP_DB, {
						key,
						enabled: args.enabled,
						rolloutPercent:
							args.rolloutPercent === undefined ? null : args.rolloutPercent,
						note: args.note,
						updatedBy,
					})
					const flags = await listFeatureFlagsForAdmin(ctx.env.APP_DB)
					const flag = flags.find((entry) => entry.key === key)
					if (!flag) {
						throw new Error(`Feature flag "${key}" was not found after update.`)
					}
					return { flag }
				},
				{
					successReason: ({ flag }) =>
						`key=${flag.key};enabled=${flag.global?.enabled ?? false};rollout=${flag.global?.rolloutPercent ?? 'null'}`,
				},
			)
		},
	},
)
