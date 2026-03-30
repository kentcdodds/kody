import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { getValue, saveValue } from '#mcp/values/service.ts'
import {
	buildConnectorValueName,
	connectorConfigSchema,
	connectorSaveSchema,
	mergeConnectorConfig,
	normalizeConnectorConfig,
	parseConnectorConfig,
	parseConnectorJson,
} from './connector-shared.ts'

const inputSchema = connectorSaveSchema

const outputSchema = z.object({
	connector: connectorConfigSchema,
})

export const connectorSaveCapability = defineDomainCapability(
	capabilityDomainNames.values,
	{
		name: 'connector_save',
		description:
			'Create or update an OAuth connector configuration for the signed-in user. Stored as a user-scoped value with a _connector: prefix.',
		keywords: [
			'connector',
			'oauth',
			'config',
			'registry',
			'save',
			'update',
			'upsert',
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
			const existingConnector =
				existing == null
					? null
					: parseConnectorConfig(parseConnectorJson(existing.value), args.name)
			const connector = existingConnector
				? mergeConnectorConfig(existingConnector, args)
				: normalizeConnectorConfig(
						connectorConfigSchema.parse({
							name: args.name,
							tokenUrl: args.tokenUrl,
							apiBaseUrl: args.apiBaseUrl ?? null,
							flow: args.flow,
							clientIdValueName: args.clientIdValueName,
							clientSecretSecretName: args.clientSecretSecretName ?? null,
							accessTokenSecretName: args.accessTokenSecretName,
							refreshTokenSecretName: args.refreshTokenSecretName ?? null,
							requiredHosts: args.requiredHosts,
						}),
					)
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
