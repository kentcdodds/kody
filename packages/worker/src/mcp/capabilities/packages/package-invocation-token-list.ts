import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { emptyCapabilityInputSchema } from '#mcp/capabilities/types.ts'
import { listPackageInvocationTokensByUserId } from '#worker/package-invocations/repo.ts'
import { packageInvocationTokenMetadataSchema } from './shared.ts'

export const packageInvocationTokenListCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'package_invocation_token_list',
		description:
			'List package invocation token record metadata for the signed-in user, including package/export/source scopes, timestamps, last-used, and revocation status. Raw bearer token values and stored token hashes are never returned.',
		keywords: [
			'package invocation token',
			'invocation token',
			'bearer token',
			'external package invocation',
			'metadata',
			'list',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: emptyCapabilityInputSchema,
		outputSchema: z.object({
			tokens: z.array(packageInvocationTokenMetadataSchema),
		}),
		async handler(_args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const tokens = await listPackageInvocationTokensByUserId({
				db: ctx.env.APP_DB,
				userId: user.userId,
			})
			return {
				tokens: tokens.map((token) => ({
					token_id: token.id,
					name: token.name,
					package_ids: token.packageIds,
					package_kody_ids: token.packageKodyIds,
					export_names: token.exportNames,
					allowed_sources: token.sources,
					created_at: token.created_at,
					updated_at: token.updated_at,
					last_used_at: token.last_used_at,
					revoked_at: token.revoked_at,
				})),
			}
		},
	},
)
