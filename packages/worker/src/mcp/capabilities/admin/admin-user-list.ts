import { z } from 'zod'
import { loadAdminUsersData } from '#app/admin-users-data.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminCapabilityAccess,
	adminUserMetadataSchema,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const inputSchema = z.object({
	page: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe('One-indexed page of users to return. Defaults to 1.'),
	pageSize: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe('Users per page. Defaults to 20 and maxes at 100.'),
})

const outputSchema = z.object({
	total: z.number().int().nonnegative(),
	page: z.number().int().positive(),
	pageSize: z.number().int().positive(),
	users: z.array(adminUserMetadataSchema),
})

export const adminUserListCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'admin_user_list',
		description:
			'List account metadata for users, including roles. Admin-only; never returns user content.',
		keywords: ['admin', 'users', 'accounts', 'roles', 'rbac'],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'admin_user_list',
				async () => {
					const url = new URL('https://kody.local/admin/users.json')
					if (args.page) url.searchParams.set('page', String(args.page))
					if (args.pageSize) {
						url.searchParams.set('pageSize', String(args.pageSize))
					}
					const data = await loadAdminUsersData(ctx.env, url.toString())
					return {
						total: data.total,
						page: data.page,
						pageSize: data.pageSize,
						users: data.users,
					}
				},
			)
		},
	},
)
