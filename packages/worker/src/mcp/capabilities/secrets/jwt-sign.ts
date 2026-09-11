import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { createUnresolvedSecretMessage } from '#mcp/secrets/unresolved-secret.ts'
import { assertPackageCanAccessResolvedSecret } from '#mcp/secrets/package-access.ts'
import { resolveCallerSecretAuthority } from '#mcp/secrets/secret-authority.ts'
import { resolveSecret } from '#mcp/secrets/service.ts'
import { secretScopeValues } from '#mcp/secrets/types.ts'
import {
	decodeHmacKeyMaterial,
	extractSecretMaterial,
	isHmacJwtAlgorithm,
	jwtAlgorithms,
	jwtKeyEncodings,
	signJwt,
} from './jwt-signing.ts'

const jwtAlgorithmSchema = z.enum(jwtAlgorithms)
const jwtKeyEncodingSchema = z.enum(jwtKeyEncodings)

const jwtClaimsSchema = z.record(z.string(), z.unknown())

const jwtSignInputSchema = z.object({
	private_key_secret_name: z
		.string()
		.min(1)
		.describe(
			'Name of the saved signing-key secret: PKCS#8 PEM for RS*, PS*, ES*, and EdDSA, or HMAC key material for HS*.',
		),
	private_key_secret_scope: z
		.enum(secretScopeValues)
		.optional()
		.describe(
			'Optional secret scope. When omitted, Kody checks accessible scopes in precedence order.',
		),
	private_key_json_field: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Optional JSON object field containing the signing key, for example "private_key" for service-account JSON.',
		),
	algorithm: jwtAlgorithmSchema.default('RS256'),
	key_encoding: jwtKeyEncodingSchema
		.optional()
		.describe(
			'HMAC key encoding when algorithm is HS256, HS384, or HS512. Defaults to base64 (DoorDash Drive signing_secret). Not valid for RS*, PS*, ES*, or EdDSA.',
		),
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
		name: 'secretJwtSign',
		description:
			'Sign a JWT with a key stored in a saved secret without revealing the key. HMAC algorithms (HS256, HS384, HS512) use key material from the secret; RS*, PS*, ES*, and EdDSA use a PKCS#8 PEM private key. This generic primitive only signs caller-provided header and claims; package or execute code should perform any OAuth token exchange separately.',
		keywords: [
			'jwt',
			'sign',
			'signing key',
			'private key',
			'hmac',
			'hs256',
			'rs256',
			'ps256',
			'es256',
			'ecdsa',
			'eddsa',
			'ed25519',
			'service account',
			'oauth',
			'doordash',
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
			const { authorityPackageId, storageContext } =
				resolveCallerSecretAuthority({
					storageContext: ctx.callerContext.storageContext,
				})
			const resolved = await resolveSecret({
				env: ctx.env,
				userId: user.userId,
				name: args.private_key_secret_name,
				scope: args.private_key_secret_scope,
				storageContext,
			})
			if (!resolved.found || typeof resolved.value !== 'string') {
				throw new Error(
					await createUnresolvedSecretMessage({
						env: ctx.env,
						userId: user.userId,
						name: args.private_key_secret_name,
						scope: args.private_key_secret_scope,
						storageContext,
						baseUrl: ctx.callerContext.baseUrl,
					}),
				)
			}
			await assertPackageCanAccessResolvedSecret({
				env: ctx.env,
				baseUrl: ctx.callerContext.baseUrl,
				userId: user.userId,
				storageContext,
				authorityPackageId,
				secretName: args.private_key_secret_name,
				resolved,
			})

			const secretMaterial = extractSecretMaterial({
				secretValue: resolved.value,
				jsonField: args.private_key_json_field,
			})

			if (isHmacJwtAlgorithm(args.algorithm)) {
				return {
					jwt: await signJwt({
						algorithm: args.algorithm,
						hmacKeyBytes: decodeHmacKeyMaterial({
							secretValue: secretMaterial,
							encoding: args.key_encoding ?? 'base64',
						}),
						header: args.header,
						claims: args.claims,
					}),
					algorithm: args.algorithm,
				}
			}

			if (args.key_encoding !== undefined) {
				throw new Error(
					'key_encoding is only valid when algorithm is HS256, HS384, or HS512.',
				)
			}

			return {
				jwt: await signJwt({
					algorithm: args.algorithm,
					privateKeyPem: secretMaterial,
					header: args.header,
					claims: args.claims,
				}),
				algorithm: args.algorithm,
			}
		},
	},
)
