import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	emptyCapabilityInputSchema,
	type CapabilityContext,
} from '#mcp/capabilities/types.ts'
import { listValues } from '#mcp/values/service.ts'
import {
	integrationConfigSchema,
	parseIntegrationConfig,
	parseIntegrationValueName,
	parseIntegrationJson,
} from './integration-shared.ts'

const outputSchema = z.object({
	integrations: z.array(integrationConfigSchema),
})

export const integrationListCapability = defineDomainCapability(
	capabilityDomainNames.integrations,
	{
		name: 'integration_list',
		description: 'List saved OAuth integration configurations.',
		keywords: ['integration', 'oauth', 'config', 'registry', 'list', 'value'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: emptyCapabilityInputSchema,
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
					storageId: ctx.callerContext.storageContext?.storageId ?? null,
				},
			})
			const integrations = values
				.map((value) => {
					const integrationName = parseIntegrationValueName(value.name)
					if (!integrationName) return null
					return parseIntegrationConfig(
						parseIntegrationJson(value.value),
						integrationName,
					)
				})
				.filter((entry): entry is z.infer<typeof integrationConfigSchema> =>
					Boolean(entry),
				)
			return { integrations }
		},
	},
)
