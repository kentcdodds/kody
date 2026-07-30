import { z } from 'zod'
import { createPlatformAccount } from '#worker/identity/platform-account-creation.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
	buildCreatedUserAuditReason,
	stableUserIdSchema,
} from './admin-shared.ts'

const inputSchema = z.object({
	email: z.email().describe('Email address for the platform account.'),
	username: z
		.string()
		.min(1)
		.describe(
			'Reserved username for the platform account (without "@"), for example "kody".',
		),
})

const outputSchema = z.object({
	platformAccount: z.object({
		stableUserId: stableUserIdSchema,
		email: z.string(),
		username: z.string(),
	}),
})

export const adminPlatformAccountCreateCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'admin_platform_account_create',
		description:
			'Create a platform account that holds official/platform-owned packages. Platform accounts can only claim reserved usernames and never log in. Admin-only; does not expose user content.',
		keywords: [
			'admin',
			'platform',
			'account',
			'create',
			'package scope',
			'reserved username',
			'official packages',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'admin_platform_account_create',
				async () => {
					const created = await createPlatformAccount({
						db: ctx.env.APP_DB,
						email: args.email,
						username: args.username,
					})
					return {
						platformAccount: {
							stableUserId: created.stableUserId,
							email: created.email,
							username: created.username,
						},
					}
				},
				{
					successReason: ({ platformAccount }) =>
						buildCreatedUserAuditReason({
							stableUserId: platformAccount.stableUserId,
							email: platformAccount.email,
						}),
				},
			)
		},
	},
)
