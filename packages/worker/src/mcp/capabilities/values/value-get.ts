import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { assertValueNameAllowed } from '#mcp/values/value-name-guards.ts'
import { getValue } from '#mcp/values/service.ts'
import { valueScopeValues } from '#mcp/values/types.ts'
import { valueMetadataSchema } from './shared.ts'

export const valueGetCapability = defineDomainCapability(
	capabilityDomainNames.values,
	{
		name: 'value_get',
		description:
			'Read a persisted non-secret value by name. When scope is omitted, Kody checks the accessible scopes in precedence order.',
		keywords: ['value', 'config', 'read', 'lookup', 'non-secret'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			name: z.string().min(1).describe('Persisted value name to read.'),
			scope: z
				.enum(valueScopeValues)
				.optional()
				.describe(
					'Optional scope filter. When omitted, look up the value in accessible scopes in precedence order.',
				),
		}),
		outputSchema: valueMetadataSchema.nullable(),
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const name = args.name.trim()
			assertValueNameAllowed(name)
			const value = await getValue({
				env: ctx.env,
				userId: user.userId,
				name,
				scope: args.scope ?? null,
				storageContext: {
					sessionId: ctx.callerContext.storageContext?.sessionId ?? null,
					appId: ctx.callerContext.storageContext?.appId ?? null,
					storageId: ctx.callerContext.storageContext?.storageId ?? null,
				},
			})
			return value
				? {
						name: value.name,
						scope: value.scope,
						value: value.value,
						description: value.description,
						app_id: value.appId,
						created_at: value.createdAt,
						updated_at: value.updatedAt,
						ttl_ms: value.ttlMs,
					}
				: null
		},
	},
)
