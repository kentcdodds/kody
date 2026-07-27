import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	emptyCapabilityInputSchema,
	type CapabilityContext,
} from '#mcp/capabilities/types.ts'
import { listIntegrations } from '#worker/integrations/service.ts'
import { integrationConfigSchema } from './integration-shared.ts'

const outputSchema = z.object({
	integrations: z.array(integrationConfigSchema),
})

export const integrationListCapability = defineDomainCapability(
	capabilityDomainNames.integrations,
	{
		name: 'integration_list',
		description: 'List saved OAuth integration configurations.',
		keywords: [
			'integration',
			'oauth',
			'config',
			'registry',
			'list',
			'connection',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: emptyCapabilityInputSchema,
		outputSchema,
		async handler(_args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const integrations = await listIntegrations({
				env: ctx.env,
				userId: user.userId,
			})
			return { integrations }
		},
	},
)
