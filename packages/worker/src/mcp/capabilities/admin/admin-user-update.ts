import { z } from 'zod'
import { updateAdminUserPlan } from '#worker/admin/users-data.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { resolvePlanWrite } from '#worker/entitlements/plans.ts'
import {
	adminMutationCapabilityAccess,
	adminUserMetadataSchema,
	auditAdminCapabilityInvocation,
	planNameSchema,
	stableUserIdSchema,
} from './admin-shared.ts'

const inputSchema = z
	.object({
		stableUserId: stableUserIdSchema.optional(),
		email: z.string().email().optional().describe('Email address to update.'),
		username: z.string().min(1).optional().describe('Username to update.'),
		plan: planNameSchema
			.nullable()
			.describe(
				'Entitlement plan to set. Null maps to free (never persists NULL).',
			),
	})
	.refine(
		(value) =>
			[value.stableUserId, value.email, value.username].filter(
				(item) => item !== undefined,
			).length === 1,
		{ message: 'Provide exactly one of stableUserId, email, or username.' },
	)

const outputSchema = z.object({
	user: adminUserMetadataSchema,
})

export const adminUserUpdateCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'admin_user_update',
		description:
			'Update account metadata for one user by stable user id, email, or username. Supports setting the entitlement plan (null maps to free). Admin-only; never touches user content.',
		keywords: ['admin', 'user', 'update', 'account', 'plan', 'entitlements'],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'admin_user_update',
				async () => {
					const user = await updateAdminUserPlan(ctx.env.APP_DB, {
						stableUserId: args.stableUserId,
						email: args.email,
						username: args.username,
						plan: resolvePlanWrite(args.plan),
					})
					if (!user) {
						throw new Error('User not found.')
					}
					return { user }
				},
				{
					successReason: ({ user }) =>
						`target_stable_user_id=${user.stableUserId};plan=${user.plan}`,
				},
			)
		},
	},
)
