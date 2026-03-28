import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { saveValue } from '#mcp/values/service.ts'
import {
	buildConnectorValueName,
	connectorConfigSchema,
	connectorFlowValues,
	normalizeConnectorConfig,
	parseConnectorConfig,
	parseConnectorJson,
} from './connector-shared.ts'

const inputSchema = z.object({
	name: z.string().min(1).describe('Connector name to save.'),
	tokenUrl: z.string().url().describe('OAuth token endpoint for the provider.'),
	flow: z
		.enum(connectorFlowValues)
		.describe('OAuth flow type for the provider.'),
	clientIdValueName: z
		.string()
		.min(1)
		.describe('Value name that stores the OAuth client ID.'),
	clientSecretSecretName: z
		.string()
		.min(1)
		.optional()
		.nullable()
		.describe('Secret name that stores the OAuth client secret.'),
	accessTokenSecretName: z
		.string()
		.min(1)
		.describe('Secret name that stores the OAuth access token.'),
	refreshTokenSecretName: z
		.string()
		.min(1)
		.optional()
		.nullable()
		.describe('Secret name that stores the OAuth refresh token.'),
	requiredHosts: z
		.array(z.string())
		.optional()
		.describe('Hosts that must be approved for outbound secret usage.'),
})

const outputSchema = z.object({
	connector: connectorConfigSchema,
})

export const connectorSaveCapability = defineDomainCapability(
	capabilityDomainNames.values,
	{
		name: 'connector_save',
		description:
			'Save an OAuth connector configuration for the signed-in user. Stored as a user-scoped value with a _connector: prefix.',
		keywords: ['connector', 'oauth', 'config', 'registry', 'save', 'value'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const connector = normalizeConnectorConfig(
				connectorConfigSchema.parse(args),
			)
			const value = await saveValue({
				env: ctx.env,
				userId: user.userId,
				name: buildConnectorValueName(connector.name),
				value: JSON.stringify(connector),
				scope: 'user',
				description: `OAuth connector config for ${connector.name}`,
				storageContext: {
					sessionId: ctx.callerContext.storageContext?.sessionId ?? null,
					appId: ctx.callerContext.storageContext?.appId ?? null,
				},
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
