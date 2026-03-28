import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { getValue } from '#mcp/values/service.ts'
import {
	buildConnectorValueName,
	connectorConfigSchema,
	parseConnectorConfig,
} from './connector-shared.ts'

const inputSchema = z.object({
	name: z.string().min(1).describe('Connector name to read.'),
})

const outputSchema = z.object({
	connector: connectorConfigSchema.nullable(),
})

export const connectorGetCapability = defineDomainCapability(
	capabilityDomainNames.values,
	{
		name: 'connector_get',
		description: 'Read an OAuth connector configuration by name.',
		keywords: ['connector', 'oauth', 'config', 'registry', 'read', 'value'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const value = await getValue({
				env: ctx.env,
				userId: user.userId,
				name: buildConnectorValueName(args.name),
				scope: 'user',
				storageContext: {
					sessionId: ctx.callerContext.storageContext?.sessionId ?? null,
					appId: ctx.callerContext.storageContext?.appId ?? null,
				},
			})
			if (!value) {
				return { connector: null }
			}
			const parsed = parseConnectorConfig(
				parseConnectorJson(value.value),
				args.name,
			)
			return {
				connector: parsed,
			}
		},
	},
)

function parseConnectorJson(raw: string) {
	try {
		return JSON.parse(raw)
	} catch {
		return null
	}
}
