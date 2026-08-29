import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { assertPackageCanAccessResolvedSecret } from '#mcp/secrets/package-access.ts'
import {
	resolveSecret,
	saveSecret,
	updateSecret,
	updateUserSecretForPackage,
} from '#mcp/secrets/service.ts'
import { secretScopeValues } from '#mcp/secrets/types.ts'
import { secretMetadataSchema, toSecretCapabilityOutput } from './shared.ts'

const secretSetInputSchema = z
	.object({
		name: z.string().min(1).describe('Secret name to create or update.'),
		value: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Secret value to persist. Required when creating a secret. Optional on updates that only change description or expires_at. Write-only and must never be returned to the caller.',
			),
		description: z
			.string()
			.optional()
			.describe('Optional human-readable description of the secret.'),
		expires_at: z
			.string()
			.nullable()
			.optional()
			.describe(
				'Optional UTC ISO expiry (or YYYY-MM-DD). Null or empty clears expiry. Omit on update to leave the existing expiry unchanged.',
			),
		scope: z
			.enum(secretScopeValues)
			.describe('Storage scope that owns the secret.'),
	})
	.superRefine((value, ctx) => {
		if (
			(typeof value.value !== 'string' || value.value.length === 0) &&
			value.description === undefined &&
			value.expires_at === undefined
		) {
			ctx.addIssue({
				code: 'custom',
				message:
					'Provide a secret value, or a description / expires_at update for an existing secret.',
				path: ['value'],
			})
		}
	})

const secretSetCapabilityInputJsonSchema = z.toJSONSchema(
	secretSetInputSchema,
) as Record<string, unknown>

export const secretSetCapability = defineDomainCapability(
	capabilityDomainNames.secrets,
	{
		name: 'secret_set',
		description:
			'Create or update a stored secret reference for the signed-in user. Use this for API keys, PATs, webhook HMAC secrets, and other static credentials already available inside trusted execution. Do not persist OAuth access or refresh tokens here — `/connect/oauth` and `createAuthenticatedFetch` / `integration_token_refresh` write those on the connection. Optional expires_at is a UTC ISO timestamp or YYYY-MM-DD; null clears expiry. Updates that only change description or expiry may omit value. Use `/account/secrets/new` for user-provided API key, PAT, and credential entry or rotation. Host use is authorized through secret policy approvals. Saved secrets are consumed in outbound `fetch` calls by placeholder, e.g. `{{secret:name}}`, resolved only for approved hosts.',
		keywords: [
			'secret',
			'persist',
			'store',
			'api key',
			'pat',
			'credential',
			'expires',
			'expiry',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: secretSetCapabilityInputJsonSchema,
		outputSchema: secretMetadataSchema,
		async handler(args, ctx: CapabilityContext) {
			const parsed = secretSetInputSchema.parse(args)
			const user = requireMcpUser(ctx.callerContext)
			const storageContext = {
				sessionId: ctx.callerContext.storageContext?.sessionId ?? null,
				appId: ctx.callerContext.storageContext?.appId ?? null,
				packageId: ctx.callerContext.storageContext?.packageId ?? null,
				storageId: ctx.callerContext.storageContext?.storageId ?? null,
			}
			let saved
			if (parsed.scope === 'user' && storageContext.packageId) {
				if (parsed.expires_at !== undefined) {
					throw new McpCallerError(
						'Package runtimes cannot change user secret expiry. Set expires_at from the account page or secret_set outside a package.',
					)
				}
				if (typeof parsed.value !== 'string' || parsed.value.length === 0) {
					throw new McpCallerError(
						'Package runtimes must supply a secret value when updating a user secret.',
					)
				}
				const existing = await resolveSecret({
					env: ctx.env,
					userId: user.userId,
					name: parsed.name,
					scope: 'user',
					storageContext,
				})
				if (!existing.found) {
					throw new McpCallerError(
						'Package runtimes cannot create user-scoped secrets. Create the secret from the account page and approve the package first.',
					)
				}
				await assertPackageCanAccessResolvedSecret({
					env: ctx.env,
					baseUrl: ctx.callerContext.baseUrl,
					userId: user.userId,
					storageContext,
					secretName: parsed.name,
					resolved: existing,
					intent: 'mutate',
				})
				saved = await updateUserSecretForPackage({
					env: ctx.env,
					userId: user.userId,
					userEmail: user.email,
					packageId: storageContext.packageId,
					name: parsed.name,
					value: parsed.value,
					description: parsed.description,
				})
			} else if (typeof parsed.value === 'string' && parsed.value.length > 0) {
				saved = await saveSecret({
					env: ctx.env,
					userId: user.userId,
					userEmail: user.email,
					scope: parsed.scope,
					name: parsed.name,
					value: parsed.value,
					description: parsed.description ?? '',
					expiresAt: parsed.expires_at,
					storageContext,
				})
			} else {
				saved = await updateSecret({
					env: ctx.env,
					userId: user.userId,
					scope: parsed.scope,
					name: parsed.name,
					description: parsed.description,
					expiresAt: parsed.expires_at,
					storageContext,
				})
			}
			return toSecretCapabilityOutput(saved)
		},
	},
)
