import { z } from 'zod'
import { adminCreateUserWithPasswordSetup } from '#worker/identity/admin-user-creation.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
	buildCreatedUserAuditReason,
} from './admin-shared.ts'

const inputSchema = z.object({
	email: z.email().describe('Email address for the account to create.'),
	username: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Optional username. When omitted, Kody generates an available username from the email local part.',
		),
})

const outputSchema = z.object({
	createdUser: z.object({
		userId: z.number().int().positive(),
		email: z.string(),
		username: z.string(),
		setupLink: z.string(),
		setupTokenExpiresAt: z.number().int().positive(),
	}),
})

export const adminUserCreateCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'admin_user_create',
		description:
			'Create one user account by email, assign the default user role, and return a password setup link. Admin-only; does not expose user content.',
		keywords: [
			'admin',
			'user',
			'create',
			'account',
			'email',
			'password setup',
			'invite',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'admin_user_create',
				async () => {
					const createdUser = await adminCreateUserWithPasswordSetup({
						db: ctx.env.APP_DB,
						email: args.email,
						username: args.username,
						setupLinkOrigin: ctx.callerContext.baseUrl,
					})
					return { createdUser }
				},
				{
					successReason: ({ createdUser }) =>
						buildCreatedUserAuditReason({
							userId: createdUser.userId,
							email: createdUser.email,
						}),
				},
			)
		},
	},
)
