import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { deleteWebhookEndpointForUser } from '#worker/webhooks/service.ts'

export const webhookEndpointDeleteCapability = defineDomainCapability(
	capabilityDomainNames.webhooks,
	{
		name: 'webhook_endpoint_delete',
		description:
			'Delete an inbound webhook endpoint and its recent delivery log rows.',
		keywords: ['webhook', 'endpoint', 'delete', 'remove'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: z.object({
			id: z.string().min(1).describe('Webhook endpoint id to delete.'),
		}),
		outputSchema: z.object({
			id: z.string(),
			deleted: z.literal(true),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const deleted = await deleteWebhookEndpointForUser({
				db: ctx.env.APP_DB,
				userId: user.userId,
				endpointId: args.id,
			})
			if (!deleted) {
				throw new Error('Webhook endpoint not found.')
			}
			return { id: args.id, deleted: true as const }
		},
	},
)
