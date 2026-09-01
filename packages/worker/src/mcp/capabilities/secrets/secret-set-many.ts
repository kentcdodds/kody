import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { assertCanSetSecrets } from '#mcp/secrets/package-access.ts'
import { setSecretsAtomically } from '#mcp/secrets/service.ts'
import { secretScopeValues } from '#mcp/secrets/types.ts'
import { secretMetadataSchema, toSecretCapabilityOutput } from './shared.ts'

const secretSetManyEntrySchema = z.object({
	name: z.string().min(1).describe('Secret name to create or update.'),
	value: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Secret value to persist. Required unless assertOnly is true. Write-only and must never be returned to the caller.',
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

const secretSetManyInputSchema = z
	.object({
		secrets: z
			.array(secretSetManyEntrySchema)
			.min(1)
			.describe(
				'Secrets to assert and optionally persist. Order is preserved. Do not include OAuth access or refresh tokens — those persist on the connection.',
			),
		assertOnly: z
			.boolean()
			.optional()
			.describe(
				'When true, only authorize the writes (no values required) and do not persist. Use before a multi-write that must not partially succeed.',
			),
	})
	.superRefine((value, ctx) => {
		if (value.assertOnly) return
		for (const [index, secret] of value.secrets.entries()) {
			if (typeof secret.value !== 'string' || secret.value.length === 0) {
				ctx.addIssue({
					code: 'custom',
					message: 'Secret value is required unless assertOnly is true.',
					path: ['secrets', index, 'value'],
				})
			}
		}
	})

const secretSetManyCapabilityInputJsonSchema = z.toJSONSchema(
	secretSetManyInputSchema,
) as Record<string, unknown>

const secretSetManyOutputSchema = z.object({
	ok: z.literal(true),
	assertOnly: z.boolean(),
	secrets: z.array(secretMetadataSchema),
})

export const secretSetManyCapability = defineDomainCapability(
	capabilityDomainNames.secrets,
	{
		name: 'secretSetMany',
		description:
			'Assert authorization for, and optionally atomically persist, multiple secret references for the signed-in user (API keys, PATs, HMAC secrets). Use assertOnly before a multi-write that must not partially succeed. Do not use this for OAuth access or refresh tokens — `/connect/oauth` and `createAuthenticatedFetch` / `integrationTokenRefresh` persist those on the connection. Host use is authorized through secret policy approvals. Saved secrets are consumed in outbound `fetch` calls by placeholder, e.g. `{{secret:name}}`, resolved only for approved hosts.',
		keywords: [
			'secret',
			'persist',
			'store',
			'api key',
			'pat',
			'credential',
			'atomic',
			'batch',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: secretSetManyCapabilityInputJsonSchema,
		outputSchema: secretSetManyOutputSchema,
		async handler(args, ctx: CapabilityContext) {
			const parsed = secretSetManyInputSchema.parse(args)
			const user = requireMcpUser(ctx.callerContext)
			const storageContext = {
				sessionId: ctx.callerContext.storageContext?.sessionId ?? null,
				appId: ctx.callerContext.storageContext?.appId ?? null,
				packageId: ctx.callerContext.storageContext?.packageId ?? null,
				storageId: ctx.callerContext.storageContext?.storageId ?? null,
			}
			await assertCanSetSecrets({
				env: ctx.env,
				userId: user.userId,
				baseUrl: ctx.callerContext.baseUrl,
				secrets: parsed.secrets.map((secret) => ({
					name: secret.name,
					scope: secret.scope,
				})),
				storageContext,
			})
			if (parsed.assertOnly) {
				return {
					ok: true as const,
					assertOnly: true,
					secrets: [],
				}
			}
			const saved = await setSecretsAtomically({
				env: ctx.env,
				userId: user.userId,
				userEmail: user.email,
				secrets: parsed.secrets.map((secret) => ({
					name: secret.name,
					value: secret.value as string,
					scope: secret.scope,
					description: secret.description,
					expiresAt: secret.expires_at,
				})),
				storageContext,
			})
			return {
				ok: true as const,
				assertOnly: false,
				secrets: saved.map((entry) => toSecretCapabilityOutput(entry)),
			}
		},
	},
)
