import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { refreshIntegrationTokens } from '#worker/integrations/token-refresh.ts'

const inputSchema = z.object({
	name: z
		.string()
		.min(1)
		.describe('Integration (connection) name whose tokens should refresh.'),
})

const outputSchema = z.object({
	ok: z.literal(true),
	refreshedAt: z.string(),
	refreshTokenRotated: z.boolean(),
})

export const integrationTokenRefreshCapability = defineDomainCapability(
	capabilityDomainNames.integrations,
	{
		name: 'integration_token_refresh',
		description:
			'Refresh the OAuth access token for a saved integration host-side and persist the new tokens to the user secret store. Returns metadata only — token values never appear in the output. createAuthenticatedFetch refreshes through this path for every integration; it is the only refresh path for platform (built-in) integrations, whose shared client secret stays server-side.',
		keywords: [
			'integration',
			'oauth',
			'token',
			'refresh',
			'access token',
			'expired',
			'platform',
			'built-in',
		],
		readOnly: false,
		// Not idempotent: providers may rotate the refresh token on each call,
		// so an automatic retry could present an already-consumed token.
		idempotent: false,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const result = await refreshIntegrationTokens({
				env: ctx.env,
				userId: user.userId,
				userEmail: user.email,
				name: args.name,
			})
			return {
				ok: true as const,
				refreshedAt: result.refreshedAt,
				refreshTokenRotated: result.refreshTokenRotated,
			}
		},
	},
)
