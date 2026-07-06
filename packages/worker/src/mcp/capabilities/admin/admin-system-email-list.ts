import { z } from 'zod'
import { loadAdminSystemEmailData } from '#app/admin-system-email-data.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const inputSchema = z.object({
	page: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe(
			'One-indexed page of system email messages to return. Defaults to 1.',
		),
	pageSize: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe('Messages per page. Defaults to 25 and maxes at 100.'),
})

export const adminSystemEmailListItemSchema = z.object({
	id: z.string(),
	inbox_local_part: z.string(),
	from_address: z.string().nullable(),
	envelope_from: z.string().nullable(),
	subject: z.string().nullable(),
	processing_status: z.string(),
	raw_size: z.number().int().nonnegative(),
	received_at: z.string().nullable(),
	created_at: z.string(),
})

const outputSchema = z.object({
	total: z.number().int().nonnegative(),
	page: z.number().int().positive(),
	pageSize: z.number().int().positive(),
	ownerId: z
		.string()
		.describe(
			'Reserved operator-owned storage owner id; not a user account id.',
		),
	systemLocals: z.array(z.string()),
	messages: z.array(adminSystemEmailListItemSchema),
})

export const adminSystemEmailListCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'admin_system_email_list',
		description:
			'List operator-owned system inbox messages for reserved platform addresses. Admin-only; never returns user-owned email.',
		keywords: [
			'admin',
			'system email',
			'operator inbox',
			'abuse',
			'postmaster',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'admin_system_email_list',
				async () => {
					const url = new URL('https://kody.local/admin/system-email.json')
					if (args.page) url.searchParams.set('page', String(args.page))
					if (args.pageSize) {
						url.searchParams.set('pageSize', String(args.pageSize))
					}
					const data = await loadAdminSystemEmailData(ctx.env, url.toString())
					return {
						total: data.total,
						page: data.page,
						pageSize: data.pageSize,
						ownerId: data.ownerId,
						systemLocals: data.systemLocals,
						messages: data.messages,
					}
				},
			)
		},
	},
)
