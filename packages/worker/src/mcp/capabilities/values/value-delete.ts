import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { deleteValue } from '#mcp/values/service.ts'
import { valueScopeValues } from '#mcp/values/types.ts'

export const valueDeleteCapability = defineDomainCapability(
	capabilityDomainNames.values,
	{
		name: 'value_delete',
		description:
			'Delete an existing readable persisted value for the signed-in user.',
		keywords: ['value', 'config', 'delete', 'remove', 'non-secret'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: z.object({
			name: z.string().min(1).describe('Persisted value name to delete.'),
			scope: z
				.enum(valueScopeValues)
				.describe('Scope that owns the persisted value being deleted.'),
		}),
		outputSchema: z.object({
			deleted: z.boolean(),
		}),
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			return {
				deleted: await deleteValue({
					env: ctx.env,
					userId: user.userId,
					name: args.name,
					scope: args.scope,
					storageContext: {
						sessionId: ctx.callerContext.storageContext?.sessionId ?? null,
						appId: ctx.callerContext.storageContext?.appId ?? null,
						storageId: ctx.callerContext.storageContext?.storageId ?? null,
					},
				}),
			}
		},
	},
)
