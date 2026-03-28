import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { listValues } from '#mcp/values/service.ts'
import {
	connectorConfigSchema,
	parseConnectorConfig,
	parseConnectorValueName,
} from './connector-shared.ts'

const inputSchema = z.object({})

const outputSchema = z.object({
	connectors: z.array(connectorConfigSchema),
})

export const connectorListCapability = defineDomainCapability(
	capabilityDomainNames.values,
	{
		name: 'connector_list',
		description: 'List saved OAuth connector configurations.',
		keywords: ['connector', 'oauth', 'config', 'registry', 'list', 'value'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(_args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const values = await listValues({
				env: ctx.env,
				userId: user.userId,
				scope: 'user',
				storageContext: {
					sessionId: ctx.callerContext.storageContext?.sessionId ?? null,
					appId: ctx.callerContext.storageContext?.appId ?? null,
				},
			})
			const connectors = values
				.map((value) => {
					const connectorName = parseConnectorValueName(value.name)
					if (!connectorName) return null
					return parseConnectorConfig(
						parseConnectorJson(value.value),
						connectorName,
					)
				})
				.filter((entry): entry is z.infer<typeof connectorConfigSchema> =>
					Boolean(entry),
				)
			return { connectors }
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
