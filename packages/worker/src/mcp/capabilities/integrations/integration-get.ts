import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { getIntegration } from '#worker/integrations/service.ts'
import { integrationConfigSchema } from './integration-shared.ts'

const inputSchema = z.object({
	name: z.string().min(1).describe('Integration name to read.'),
})

const outputSchema = z.object({
	integration: integrationConfigSchema.nullable(),
})

export const integrationGetCapability = defineDomainCapability(
	capabilityDomainNames.integrations,
	{
		name: 'integration_get',
		description: 'Read an OAuth integration configuration by name.',
		keywords: [
			'integration',
			'oauth',
			'config',
			'registry',
			'read',
			'connection',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const integration = await getIntegration({
				env: ctx.env,
				userId: user.userId,
				name: args.name,
			})
			return { integration }
		},
	},
)
