import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { deleteIntegration } from '#worker/integrations/service.ts'

const inputSchema = z.object({
	name: z.string().min(1).describe('Integration name to delete.'),
})

const outputSchema = z.object({
	deleted: z.boolean(),
})

export const integrationDeleteCapability = defineDomainCapability(
	capabilityDomainNames.integrations,
	{
		name: 'integration_delete',
		description:
			'Delete a saved OAuth integration connection by name. When it is the last connection on its OAuth app, the unused app is removed too.',
		keywords: [
			'integration',
			'oauth',
			'config',
			'registry',
			'delete',
			'connection',
		],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const deleted = await deleteIntegration({
				env: ctx.env,
				userId: user.userId,
				name: args.name,
			})
			return { deleted }
		},
	},
)
