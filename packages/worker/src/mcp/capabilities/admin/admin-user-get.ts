import { z } from 'zod'
import { loadAdminUserByIdOrEmail } from '#worker/admin/users-data.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminCapabilityAccess,
	adminUserMetadataSchema,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const inputSchema = z
	.object({
		id: z
			.number()
			.int()
			.positive()
			.optional()
			.describe('Numeric users.id to look up.'),
		email: z.string().email().optional().describe('Email address to look up.'),
	})
	.refine((value) => value.id !== undefined || value.email !== undefined, {
		message: 'Provide either id or email.',
	})

const outputSchema = z.object({
	user: adminUserMetadataSchema.nullable(),
})

export const adminUserGetCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'admin_user_get',
		description:
			'Get one user account metadata record and roles by id or email. Admin-only; never returns user content.',
		keywords: ['admin', 'user', 'account', 'roles', 'lookup', 'rbac'],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(ctx, 'admin_user_get', async () => {
				const user = await loadAdminUserByIdOrEmail(ctx.env.APP_DB, args)
				return { user }
			})
		},
	},
)
