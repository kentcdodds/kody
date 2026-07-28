import { secretInputSchemaFlag } from '@kody-internal/shared/secret-input-schema.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { assertCanSetSecrets } from '#mcp/secrets/package-access.ts'
import { setSecretsAtomically } from '#mcp/secrets/service.ts'
import { secretScopeValues } from '#mcp/secrets/types.ts'
import { secretMetadataSchema } from './shared.ts'

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
				'Secrets to assert and optionally persist. Order is preserved; OAuth refresh-token rotations must list the refresh token before the access token.',
			),
		assertOnly: z
			.boolean()
			.optional()
			.describe(
				'When true, only authorize the writes (no values required) and do not persist. Use before provider token requests that may rotate refresh tokens.',
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

const secretSetManyCapabilityInputJsonSchema = (() => {
	const schema = z.toJSONSchema(secretSetManyInputSchema) as Record<
		string,
		unknown
	>
	const properties = schema.properties
	if (
		!properties ||
		typeof properties !== 'object' ||
		Array.isArray(properties)
	) {
		return schema
	}
	const propertyMap = properties as Record<string, unknown>
	const secretsProperty = propertyMap.secrets
	if (
		!secretsProperty ||
		typeof secretsProperty !== 'object' ||
		Array.isArray(secretsProperty)
	) {
		return schema
	}
	const secretsObject = secretsProperty as Record<string, unknown>
	const items = secretsObject.items
	if (!items || typeof items !== 'object' || Array.isArray(items)) {
		return schema
	}
	const itemsObject = items as Record<string, unknown>
	const itemProperties = itemsObject.properties
	if (
		!itemProperties ||
		typeof itemProperties !== 'object' ||
		Array.isArray(itemProperties)
	) {
		return schema
	}
	const itemPropertyMap = itemProperties as Record<string, unknown>
	const valueProperty = itemPropertyMap.value
	if (
		!valueProperty ||
		typeof valueProperty !== 'object' ||
		Array.isArray(valueProperty)
	) {
		return schema
	}
	return {
		...schema,
		properties: {
			...propertyMap,
			secrets: {
				...secretsObject,
				items: {
					...itemsObject,
					properties: {
						...itemPropertyMap,
						value: {
							...(valueProperty as Record<string, unknown>),
							[secretInputSchemaFlag]: true,
						},
					},
				},
			},
		},
	}
})() as Record<string, unknown>

const secretSetManyOutputSchema = z.object({
	ok: z.literal(true),
	assertOnly: z.boolean(),
	secrets: z.array(secretMetadataSchema),
})

export const secretSetManyCapability = defineDomainCapability(
	capabilityDomainNames.secrets,
	{
		name: 'secret_set_many',
		description:
			'Assert authorization for, and optionally atomically persist, multiple secret references for the signed-in user. Use assertOnly before an OAuth token refresh that may rotate refresh tokens so a permission denial cannot consume the provider token. When persisting rotated OAuth tokens, list the refresh token before the access token; both writes commit in one D1 batch. Host use and direct capability access are authorized through secret policy approvals. Saved secrets are consumed in outbound `fetch` calls by placeholder, e.g. `{{secret:name}}`, resolved only for approved hosts.',
		keywords: [
			'secret',
			'persist',
			'store',
			'oauth',
			'token',
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
				})),
				storageContext,
			})
			return {
				ok: true as const,
				assertOnly: false,
				secrets: saved.map((entry) => ({
					name: entry.name,
					scope: entry.scope,
					description: entry.description,
					package_id: entry.packageId,
					allowed_hosts: entry.allowedHosts,
					allowed_capabilities: entry.allowedCapabilities,
					allowed_packages: entry.allowedPackages,
					created_at: entry.createdAt,
					updated_at: entry.updatedAt,
					ttl_ms: entry.ttlMs,
				})),
			}
		},
	},
)
