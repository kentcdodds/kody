import { z } from 'zod'
import { normalizeUsername } from '#worker/identity/username.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	getPlatformAccountByUsername,
	listPackageScopeGrants,
} from '#worker/package-registry/scope-grants.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const inputSchema = z.object({
	scope: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Optional platform account username (without "@") to filter grants. When omitted, returns all package scope grants.',
		),
})

const outputSchema = z.object({
	grants: z.array(
		z.object({
			scope: z.string(),
			username: z.string(),
			created_by_user_id: z.string(),
			created_at: z.string(),
		}),
	),
})

export const adminPackageScopeGrantListCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'admin_package_scope_grant_list',
		description:
			'List package scope grants that let person accounts act inside platform account scopes. Optionally filter by platform account username. Admin-only; does not expose package contents.',
		keywords: [
			'admin',
			'package scope',
			'grant',
			'list',
			'platform account',
			'packages',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'admin_package_scope_grant_list',
				async () => {
					let scopeOwnerUserId: string | undefined
					if (args.scope !== undefined) {
						const scope = normalizeUsername(args.scope).replace(/^@/, '')
						const platformAccount = await getPlatformAccountByUsername(
							ctx.env.APP_DB,
							scope,
						)
						if (!platformAccount) {
							throw new Error(
								`Package scope "@${scope}" is not a platform account. Grants are only possible on platform accounts.`,
							)
						}
						scopeOwnerUserId = platformAccount.stableUserId
					}
					const rows = await listPackageScopeGrants(ctx.env.APP_DB, {
						scopeOwnerUserId,
					})
					return {
						grants: rows.map((row) => ({
							scope: row.scope_username,
							username: row.grantee_username,
							created_by_user_id: row.created_by_user_id,
							created_at: row.created_at,
						})),
					}
				},
			)
		},
	},
)
