import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { emptyCapabilityInputSchema } from '#mcp/capabilities/types.ts'
import { listWebhookEndpointsForUserService } from '#worker/webhooks/service.ts'
import { toCapabilityEndpoint, webhookEndpointSchema } from './shared.ts'

export const webhookEndpointListCapability = defineDomainCapability(
	capabilityDomainNames.webhooks,
	{
		name: 'webhook_endpoint_list',
		description:
			'List inbound webhook endpoints for the signed-in user. URL secrets and verification secrets are never returned.',
		keywords: ['webhook', 'endpoint', 'list', 'inbound'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: emptyCapabilityInputSchema,
		outputSchema: z.object({
			endpoints: z.array(webhookEndpointSchema),
		}),
		async handler(_args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const endpoints = await listWebhookEndpointsForUserService({
				db: ctx.env.APP_DB,
				userId: user.userId,
			})
			return { endpoints: endpoints.map(toCapabilityEndpoint) }
		},
	},
)
