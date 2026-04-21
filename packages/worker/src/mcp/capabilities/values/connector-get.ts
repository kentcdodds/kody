import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { listUserSecretsForSearch } from '#mcp/secrets/service.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { getValue } from '#mcp/values/service.ts'
import {
	buildConnectorValueName,
	connectorConfigSchema,
	type ConnectorConfig,
	parseConnectorConfig,
	parseConnectorJson,
} from './connector-shared.ts'
import {
	connectorReadinessSchema,
	getConnectorReadiness,
} from './connector-readiness.ts'

const inputSchema = z.object({
	name: z.string().min(1).describe('Connector name to read.'),
})

const outputSchema = z.object({
	connector: connectorConfigSchema.nullable(),
	readiness: connectorReadinessSchema.nullable(),
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
			const storageContext = {
				sessionId: ctx.callerContext.storageContext?.sessionId ?? null,
				appId: ctx.callerContext.storageContext?.appId ?? null,
				storageId: ctx.callerContext.storageContext?.storageId ?? null,
			}
			const value = await getValue({
				env: ctx.env,
				userId: user.userId,
				name: buildConnectorValueName(args.name),
				scope: 'user',
				storageContext,
			})
			if (!value) {
				return { connector: null, readiness: null }
			}
			const parsed = parseConnectorConfig(
				parseConnectorJson(value.value),
				args.name,
			)
			if (!parsed) {
				return { connector: null, readiness: null }
			}
			const readiness = await loadConnectorReadiness({
				env: ctx.env,
				userId: user.userId,
				connector: parsed,
				storageContext,
			})
			return {
				connector: parsed,
				readiness,
			}
		},
	},
)

async function loadConnectorReadiness(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	connector: ConnectorConfig
	storageContext: {
		sessionId: string | null
		appId: string | null
		storageId: string | null
	}
}) {
	const [clientIdValue, userSecrets] = await Promise.all([
		getValue({
			env: input.env,
			userId: input.userId,
			name: input.connector.clientIdValueName,
			storageContext: input.storageContext,
		}),
		listUserSecretsForSearch({
			env: input.env,
			userId: input.userId,
		}),
	])

	return getConnectorReadiness({
		connector: input.connector,
		values: clientIdValue ? [clientIdValue] : [],
		userSecrets,
	})
}
