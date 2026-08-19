import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { assertPackageCanAccessResolvedSecret } from '#mcp/secrets/package-access.ts'
import { resolveSecret } from '#mcp/secrets/service.ts'
import { getJoinedIntegration } from '#worker/integrations/service.ts'
import {
	createPlatformRawTokenRefusedMessage,
	IntegrationRawTokenRefusedError,
	IntegrationTokenRefreshCallerError,
	refreshAndMaterializeUserLaneAccessToken,
} from '#worker/integrations/token-refresh.ts'

const inputSchema = z.object({
	name: z
		.string()
		.min(1)
		.describe(
			'User-lane integration (connection) name to refresh. Returns the new access token. Platform (built-in) integrations are refused.',
		),
})

const outputSchema = z.object({
	accessToken: z.string(),
	refreshedAt: z.string(),
	refreshTokenRotated: z.boolean(),
})

async function assertCallerCanUseIntegrationTokenSecrets(input: {
	env: Env
	baseUrl: string
	userId: string
	storageContext: {
		sessionId: string | null
		appId: string | null
		packageId: string | null
		storageId: string | null
	}
	secretNames: Array<string>
}) {
	if (!input.storageContext.packageId) return
	for (const secretName of input.secretNames) {
		const resolved = await resolveSecret({
			env: input.env,
			userId: input.userId,
			name: secretName,
			scope: 'user',
			storageContext: input.storageContext,
		})
		if (!resolved.found) continue
		await assertPackageCanAccessResolvedSecret({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			storageContext: input.storageContext,
			secretName,
			resolved,
			intent: 'use',
		})
	}
}

export const integrationRefreshAccessTokenCapability = defineDomainCapability(
	capabilityDomainNames.integrations,
	{
		name: 'integration_refresh_access_token',
		description:
			'Refresh a user-lane OAuth integration host-side and return the new access token. Token rotation persists without an allowed_packages write grant (same path as integration_token_refresh). Platform (built-in) integrations are refused — use createAuthenticatedFetch instead. Prefer createAuthenticatedFetch whenever an Authorization header works.',
		keywords: [
			'integration',
			'oauth',
			'token',
			'refresh',
			'access token',
			'refreshAccessToken',
			'raw token',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const storageContext = {
				sessionId: ctx.callerContext.storageContext?.sessionId ?? null,
				appId: ctx.callerContext.storageContext?.appId ?? null,
				packageId: ctx.callerContext.storageContext?.packageId ?? null,
				storageId: ctx.callerContext.storageContext?.storageId ?? null,
			}
			const joined = await getJoinedIntegration({
				env: ctx.env,
				userId: user.userId,
				name: args.name,
			})
			if (joined?.lane === 'platform') {
				throw new McpCallerError(
					createPlatformRawTokenRefusedMessage(joined.connection.name),
				)
			}
			if (joined) {
				const secretNames = [
					joined.connection.refreshTokenSecretName,
					joined.connection.accessTokenSecretName,
				].filter((name): name is string => Boolean(name?.trim()))
				await assertCallerCanUseIntegrationTokenSecrets({
					env: ctx.env,
					baseUrl: ctx.callerContext.baseUrl,
					userId: user.userId,
					storageContext,
					secretNames,
				})
			}
			try {
				return await refreshAndMaterializeUserLaneAccessToken({
					env: ctx.env,
					userId: user.userId,
					userEmail: user.email,
					name: args.name,
					waitUntil: ctx.waitUntil,
				})
			} catch (error) {
				if (error instanceof IntegrationRawTokenRefusedError) {
					throw new McpCallerError(error.message, { cause: error })
				}
				if (error instanceof IntegrationTokenRefreshCallerError) {
					throw new McpCallerError(error.message, { cause: error })
				}
				throw error
			}
		},
	},
)
