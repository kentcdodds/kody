import { z } from 'zod'
import { updateAdminUserPlan } from '#app/admin-users-data.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminMutationCapabilityAccess,
	adminUserMetadataSchema,
	auditAdminCapabilityInvocation,
	planNameSchema,
} from './admin-shared.ts'

const inputSchema = z
	.object({
		id: z
			.number()
			.int()
			.positive()
			.optional()
			.describe('Numeric users.id to update.'),
		email: z.string().email().optional().describe('Email address to update.'),
		plan: planNameSchema
			.nullable()
			.describe(
				'Entitlement plan to set, or null to clear the plan (legacy/unlimited: no entitlement enforcement).',
			),
	})
	.refine((value) => value.id !== undefined || value.email !== undefined, {
		message: 'Provide either id or email.',
	})

const outputSchema = z.object({
	user: adminUserMetadataSchema,
})

export const adminUserUpdateCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'admin_user_update',
		description:
			'Update account metadata for one user by id or email. Supports setting or clearing the entitlement plan. Admin-only; never touches user content.',
		keywords: ['admin', 'user', 'update', 'account', 'plan', 'entitlements'],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'admin_user_update',
				async () => {
					const user = await updateAdminUserPlan(ctx.env.APP_DB, {
						id: args.id,
						email: args.email,
						plan: args.plan,
					})
					if (!user) {
						throw new Error('User not found.')
					}
					return { user }
				},
				{
					successReason: ({ user }) =>
						`target_user_id=${user.id};plan=${user.plan ?? 'null'}`,
				},
			)
		},
	},
)
