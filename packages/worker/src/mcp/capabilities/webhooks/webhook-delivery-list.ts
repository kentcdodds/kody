import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { listWebhookDeliveriesForUser } from '#worker/webhooks/service.ts'
import { toCapabilityDelivery, webhookDeliverySchema } from './shared.ts'

export const webhookDeliveryListCapability = defineDomainCapability(
	capabilityDomainNames.webhooks,
	{
		name: 'webhook_delivery_list',
		description:
			'List recent inbound webhook deliveries for one endpoint (metadata only; payload bodies are never stored).',
		keywords: ['webhook', 'delivery', 'log', 'debug', 'history'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			endpointId: z
				.string()
				.min(1)
				.describe('Webhook endpoint id whose deliveries to list.'),
			limit: z
				.number()
				.int()
				.min(1)
				.max(50)
				.optional()
				.describe('Max rows to return (default 50, max 50).'),
		}),
		outputSchema: z.object({
			deliveries: z.array(webhookDeliverySchema),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const deliveries = await listWebhookDeliveriesForUser({
				db: ctx.env.APP_DB,
				userId: user.userId,
				endpointId: args.endpointId,
				limit: args.limit,
			})
			return { deliveries: deliveries.map(toCapabilityDelivery) }
		},
	},
)
