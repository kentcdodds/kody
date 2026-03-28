import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { deleteValue } from '#mcp/values/service.ts'
import { buildConnectorValueName } from './connector-shared.ts'

const inputSchema = z.object({
	name: z.string().min(1).describe('Connector name to delete.'),
})

const outputSchema = z.object({
	deleted: z.boolean(),
})

export const connectorDeleteCapability = defineDomainCapability(
	capabilityDomainNames.values,
	{
		name: 'connector_delete',
		description: 'Delete a saved OAuth connector configuration by name.',
		keywords: ['connector', 'oauth', 'config', 'registry', 'delete', 'value'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const deleted = await deleteValue({
				env: ctx.env,
				userId: user.userId,
				name: buildConnectorValueName(args.name),
				scope: 'user',
				storageContext: {
					sessionId: ctx.callerContext.storageContext?.sessionId ?? null,
					appId: ctx.callerContext.storageContext?.appId ?? null,
				},
			})
			return { deleted }
		},
	},
)
