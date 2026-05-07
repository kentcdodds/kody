import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { getValue } from '#mcp/values/service.ts'
import {
	buildIntegrationValueName,
	integrationConfigSchema,
	parseIntegrationConfig,
	parseIntegrationJson,
} from './integration-shared.ts'

const inputSchema = z.object({
	name: z.string().min(1).describe('Integration name to read.'),
})

const outputSchema = z.object({
	integration: integrationConfigSchema.nullable(),
})

export const integrationGetCapability = defineDomainCapability(
	capabilityDomainNames.values,
	{
		name: 'integration_get',
		description: 'Read an OAuth integration configuration by name.',
		keywords: ['integration', 'oauth', 'config', 'registry', 'read', 'value'],
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
				name: buildIntegrationValueName(args.name),
				scope: 'user',
				storageContext: {
					sessionId: ctx.callerContext.storageContext?.sessionId ?? null,
					appId: ctx.callerContext.storageContext?.appId ?? null,
					storageId: ctx.callerContext.storageContext?.storageId ?? null,
				},
			})
			if (!value) {
				return { integration: null }
			}
			const parsed = parseIntegrationConfig(
				parseIntegrationJson(value.value),
				args.name,
			)
			return {
				integration: parsed,
			}
		},
	},
)
