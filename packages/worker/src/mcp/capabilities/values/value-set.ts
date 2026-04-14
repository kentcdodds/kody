import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { saveValue } from '#mcp/values/service.ts'
import { valueScopeValues } from '#mcp/values/types.ts'
import { valueMetadataSchema } from './shared.ts'

export const valueSetCapability = defineDomainCapability(
	capabilityDomainNames.values,
	{
		name: 'value_set',
		description:
			'Create or update a readable persisted value for the signed-in user. Use this for non-sensitive configuration that generated UIs may need to read back later.',
		keywords: ['value', 'config', 'persist', 'store', 'non-secret'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			name: z.string().min(1).describe('Persisted value name.'),
			value: z
				.string()
				.min(1)
				.describe('Readable value to store for later generated UI access.'),
			description: z
				.string()
				.optional()
				.describe('Optional human-readable description of the value.'),
			scope: z
				.enum(valueScopeValues)
				.default('session')
				.describe('Storage scope for the value.'),
		}),
		outputSchema: valueMetadataSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const value = await saveValue({
				env: ctx.env,
				userId: user.userId,
				name: args.name,
				value: args.value,
				scope: args.scope,
				description: args.description ?? '',
				storageContext: {
					sessionId: ctx.callerContext.storageContext?.sessionId ?? null,
					appId: ctx.callerContext.storageContext?.appId ?? null,
					storageId: ctx.callerContext.storageContext?.storageId ?? null,
				},
			})
			return {
				name: value.name,
				scope: value.scope,
				value: value.value,
				description: value.description,
				app_id: value.appId,
				created_at: value.createdAt,
				updated_at: value.updatedAt,
				ttl_ms: value.ttlMs,
			}
		},
	},
)
