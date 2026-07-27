import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	getOauthApp,
	listJoinedIntegrations,
	rotateOauthAppClientCredentials,
} from '#worker/integrations/service.ts'
import { oauthAppPublicSchema, toOauthAppPublic } from './oauth-app-shared.ts'

const inputSchema = z
	.object({
		slug: z
			.string()
			.min(1)
			.describe('OAuth app slug whose client credentials should be rotated.'),
		clientId: z.string().min(1).describe('New OAuth client id (inline value).'),
		clientSecretSecretName: z
			.string()
			.min(1)
			.nullable()
			.optional()
			.describe(
				'Secret-store name for the new client secret, or null to clear it. Omit to leave the existing secret name unchanged.',
			),
	})
	.strict()

const outputSchema = z.object({
	app: oauthAppPublicSchema,
})

export const integrationOauthAppRotateCredentialsCapability =
	defineDomainCapability(capabilityDomainNames.integrations, {
		name: 'integration_oauth_app_rotate_credentials',
		description:
			'Rotate the client id and optional client-secret secret name on a shared OAuth app. Every connection on that app sees the new credentials on the next join — one write instead of updating each connection.',
		keywords: [
			'integration',
			'oauth',
			'app',
			'client',
			'credentials',
			'rotate',
			'update',
			'secret',
		],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const existing = await getOauthApp({
				env: ctx.env,
				userId: user.userId,
				slug: args.slug,
			})
			if (!existing) {
				throw new Error(
					`OAuth app "${args.slug.trim()}" was not found for this user.`,
				)
			}
			const clientSecretSecretName =
				args.clientSecretSecretName === undefined
					? existing.clientSecretSecretName
					: args.clientSecretSecretName
			const rotated = await rotateOauthAppClientCredentials({
				env: ctx.env,
				userId: user.userId,
				slug: args.slug,
				clientId: args.clientId,
				clientSecretSecretName,
			})
			const joined = await listJoinedIntegrations({
				env: ctx.env,
				userId: user.userId,
			})
			const connections = joined
				.filter(({ app }) => app.slug === rotated.slug)
				.map(({ connection }) => ({
					name: connection.name,
					accountLabel: connection.accountLabel,
				}))
			return {
				app: toOauthAppPublic(
					{ ...rotated, connectionCount: connections.length },
					connections,
				),
			}
		},
	})
