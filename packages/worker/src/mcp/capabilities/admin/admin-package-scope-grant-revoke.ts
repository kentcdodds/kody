import { z } from 'zod'
import { normalizeUsername } from '#app/username.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	deletePackageScopeGrant,
	getPlatformAccountByUsername,
} from '#worker/package-registry/scope-grants.ts'
import { resolveUserStableId } from '#worker/user-id.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const inputSchema = z.object({
	scope: z
		.string()
		.min(1)
		.describe(
			'Platform account username that owns the package scope (without "@"), for example "kody".',
		),
	username: z
		.string()
		.min(1)
		.describe('Person account username whose package scope grant to revoke.'),
})

const outputSchema = z.object({
	deleted: z.boolean(),
	scope: z.string(),
	username: z.string(),
})

export const adminPackageScopeGrantRevokeCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'admin_package_scope_grant_revoke',
		description:
			'Revoke a person account grant to act inside a platform account package scope. Grants are only possible on platform accounts. Admin-only; does not expose package contents.',
		keywords: [
			'admin',
			'package scope',
			'grant',
			'revoke',
			'platform account',
			'packages',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const scope = normalizeUsername(args.scope).replace(/^@/, '')
			const username = normalizeUsername(args.username)
			return auditAdminCapabilityInvocation(
				ctx,
				'admin_package_scope_grant_revoke',
				async () => {
					const platformAccount = await getPlatformAccountByUsername(
						ctx.env.APP_DB,
						scope,
					)
					if (!platformAccount) {
						throw new Error(
							`Package scope "@${scope}" is not a platform account. Grants are only possible on platform accounts.`,
						)
					}
					const grantee = await ctx.env.APP_DB.prepare(
						`SELECT username, email, account_type, stable_user_id
						FROM users
						WHERE username = ?`,
					)
						.bind(username)
						.first<{
							username: string
							email: string
							account_type: string
							stable_user_id: string | null
						}>()
					if (!grantee) {
						throw new Error(`User "${username}" was not found.`)
					}
					if (grantee.account_type !== 'person') {
						throw new Error(
							`User "${username}" is not a person account and cannot hold a package scope grant.`,
						)
					}
					const { deleted } = await deletePackageScopeGrant(ctx.env.APP_DB, {
						scopeOwnerUserId: platformAccount.stableUserId,
						granteeUserId: await resolveUserStableId(grantee),
					})
					return {
						deleted,
						scope: platformAccount.username,
						username: grantee.username,
					}
				},
				{
					successReason: () => `scope=@${scope};grantee=${username}`,
				},
			)
		},
	},
)
