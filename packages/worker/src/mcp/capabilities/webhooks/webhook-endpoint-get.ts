import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { getWebhookEndpointForUser } from '#worker/webhooks/service.ts'
import { toCapabilityEndpoint, webhookEndpointSchema } from './shared.ts'

export const webhookEndpointGetCapability = defineDomainCapability(
	capabilityDomainNames.webhooks,
	{
		name: 'webhook_endpoint_get',
		description:
			'Get one inbound webhook endpoint by id. URL secrets and verification secrets are never returned.',
		keywords: ['webhook', 'endpoint', 'get', 'detail'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			id: z.string().min(1).describe('Webhook endpoint id.'),
		}),
		outputSchema: z.object({
			endpoint: webhookEndpointSchema,
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const endpoint = await getWebhookEndpointForUser({
				db: ctx.env.APP_DB,
				userId: user.userId,
				endpointId: args.id,
			})
			if (!endpoint) {
				throw new Error('Webhook endpoint not found.')
			}
			return { endpoint: toCapabilityEndpoint(endpoint) }
		},
	},
)
