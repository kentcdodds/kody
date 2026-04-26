import { markSecretInputFields } from '@kody-internal/shared/secret-input-schema.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { saveSecret } from '#mcp/secrets/service.ts'
import { secretScopeValues } from '#mcp/secrets/types.ts'
import { secretMetadataSchema } from './shared.ts'

const secretSetInputSchema = z.object({
	name: z.string().min(1).describe('Secret name to create or update.'),
	value: z
		.string()
		.min(1)
		.describe(
			'Secret value to persist. This field is write-only and must never be returned to the caller.',
		),
	description: z
		.string()
		.optional()
		.describe('Optional human-readable description of the secret.'),
	scope: z
		.enum(secretScopeValues)
		.describe('Storage scope that owns the secret.'),
})

const secretSetCapabilityInputJsonSchema = markSecretInputFields(
	z.toJSONSchema(secretSetInputSchema) as Record<string, unknown>,
	['value'],
) as Record<string, unknown>

export const secretSetCapability = defineDomainCapability(
	capabilityDomainNames.secrets,
	{
		name: 'secret_set',
		description:
			'Create or update a stored secret reference for the signed-in user without ever returning the plaintext value. Use this only for server-side persistence of secret values that are already available inside trusted execution, such as refreshed OAuth tokens. Never ask the user to paste a secret, token, API key, password, or credential into chat; use generated UI to collect missing user-provided secrets safely. Saving a secret value does not authorize outbound host use or direct capability access.',
		keywords: ['secret', 'persist', 'store', 'oauth', 'token', 'credential'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: secretSetCapabilityInputJsonSchema,
		outputSchema: secretMetadataSchema,
		async handler(args, ctx: CapabilityContext) {
			const parsed = secretSetInputSchema.parse(args)
			const user = requireMcpUser(ctx.callerContext)
			const saved = await saveSecret({
				env: ctx.env,
				userId: user.userId,
				scope: parsed.scope,
				name: parsed.name,
				value: parsed.value,
				description: parsed.description ?? '',
				storageContext: {
					sessionId: ctx.callerContext.storageContext?.sessionId ?? null,
					appId: ctx.callerContext.storageContext?.appId ?? null,
					storageId: ctx.callerContext.storageContext?.storageId ?? null,
				},
			})
			return {
				name: saved.name,
				scope: saved.scope,
				description: saved.description,
				app_id: saved.appId,
				allowed_hosts: saved.allowedHosts,
				allowed_capabilities: saved.allowedCapabilities,
				allowed_packages: saved.allowedPackages,
				created_at: saved.createdAt,
				updated_at: saved.updatedAt,
				ttl_ms: saved.ttlMs,
			}
		},
	},
)
