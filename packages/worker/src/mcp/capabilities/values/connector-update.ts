import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { getValue, saveValue } from '#mcp/values/service.ts'
import {
	buildConnectorValueName,
	connectorConfigSchema,
	connectorUpdateSchema,
	mergeConnectorConfig,
	parseConnectorConfig,
	parseConnectorJson,
} from './connector-shared.ts'

const inputSchema = connectorUpdateSchema

const outputSchema = z.object({
	connector: connectorConfigSchema,
})

export const connectorUpdateCapability = defineDomainCapability(
	capabilityDomainNames.values,
	{
		name: 'connector_update',
		description:
			'Update an existing OAuth connector configuration by name. Supports patch-style edits for connector config fields.',
		keywords: [
			'connector',
			'oauth',
			'config',
			'registry',
			'update',
			'patch',
			'edit',
			'value',
		],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const storageContext = {
				sessionId: ctx.callerContext.storageContext?.sessionId ?? null,
				appId: ctx.callerContext.storageContext?.appId ?? null,
			}
			const existing = await getValue({
				env: ctx.env,
				userId: user.userId,
				name: buildConnectorValueName(args.name),
				scope: 'user',
				storageContext,
			})
			if (!existing) {
				throw new Error(`Connector "${args.name}" was not found.`)
			}
			const current = parseConnectorConfig(
				parseConnectorJson(existing.value),
				args.name,
			)
			if (!current) {
				throw new Error(`Connector "${args.name}" is stored with invalid JSON.`)
			}
			const connector = mergeConnectorConfig(current, args)
			const value = await saveValue({
				env: ctx.env,
				userId: user.userId,
				name: buildConnectorValueName(connector.name),
				value: JSON.stringify(connector),
				scope: 'user',
				description: `OAuth connector config for ${connector.name}`,
				storageContext,
			})
			const parsed = parseConnectorConfig(
				parseConnectorJson(value.value),
				connector.name,
			)
			return {
				connector: parsed ?? connector,
			}
		},
	},
)
