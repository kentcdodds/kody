import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { buildSecretCapabilityApprovalUrl } from '#mcp/secrets/capability-approval-url.ts'
import {
	createCapabilitySecretAccessDeniedMessage,
	createMissingSecretMessage,
} from '#mcp/secrets/errors.ts'
import { resolveSecret } from '#mcp/secrets/service.ts'
import { secretScopeValues } from '#mcp/secrets/types.ts'
import {
	extractPrivateKeyPem,
	jwtAlgorithmSchema,
	signJwt,
} from './jwt-signing.ts'

const jwtClaimsSchema = z.record(z.string(), z.unknown())

const jwtSignInputSchema = z.object({
	privateKeySecretName: z
		.string()
		.min(1)
		.describe('Name of the saved secret containing a PEM key or JSON object.'),
	privateKeySecretScope: z
		.enum(secretScopeValues)
		.optional()
		.describe(
			'Optional secret scope. When omitted, Kody checks accessible scopes in precedence order.',
		),
	privateKeyJsonField: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Optional JSON object field containing the private key, for example "private_key" for service-account JSON.',
		),
	algorithm: jwtAlgorithmSchema.default('RS256'),
	header: z
		.record(z.string(), z.unknown())
		.optional()
		.describe(
			'Optional JWT header fields. "alg" must match the requested algorithm when provided.',
		),
	claims: jwtClaimsSchema.describe('JWT claims to sign.'),
})

export const jwtSignCapability = defineDomainCapability(
	capabilityDomainNames.secrets,
	{
		name: 'jwt_sign',
		description:
			'Sign a JWT with a private key stored in a saved secret without revealing the private key. This generic primitive only signs caller-provided header and claims; package or execute code should perform any OAuth token exchange separately.',
		keywords: [
			'jwt',
			'sign',
			'private key',
			'service account',
			'oauth',
			'rs256',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: jwtSignInputSchema,
		outputSchema: z.object({
			jwt: z.string(),
			algorithm: jwtAlgorithmSchema,
		}),
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const storageContext = {
				sessionId: ctx.callerContext.storageContext?.sessionId ?? null,
				appId: ctx.callerContext.storageContext?.appId ?? null,
				storageId: ctx.callerContext.storageContext?.storageId ?? null,
			}
			const resolved = await resolveSecret({
				env: ctx.env,
				userId: user.userId,
				name: args.privateKeySecretName,
				scope: args.privateKeySecretScope,
				storageContext,
			})
			if (!resolved.found || typeof resolved.value !== 'string') {
				throw new Error(createMissingSecretMessage(args.privateKeySecretName))
			}
			if (!resolved.allowedCapabilities.includes('jwt_sign')) {
				const approvalUrl = buildSecretCapabilityApprovalUrl({
					baseUrl: ctx.callerContext.baseUrl,
					name: args.privateKeySecretName,
					scope: resolved.scope ?? args.privateKeySecretScope ?? 'user',
					capabilityName: 'jwt_sign',
					storageContext,
				})
				throw new Error(
					createCapabilitySecretAccessDeniedMessage(
						args.privateKeySecretName,
						'jwt_sign',
						approvalUrl,
					),
				)
			}

			const privateKeyPem = extractPrivateKeyPem({
				secretValue: resolved.value,
				jsonField: args.privateKeyJsonField,
			})

			return {
				jwt: await signJwt({
					algorithm: args.algorithm,
					privateKeyPem,
					header: args.header,
					claims: args.claims,
				}),
				algorithm: args.algorithm,
			}
		},
	},
)
