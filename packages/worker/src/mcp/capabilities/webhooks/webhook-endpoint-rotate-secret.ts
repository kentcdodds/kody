import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { rotateWebhookEndpointSecretForUser } from '#worker/webhooks/service.ts'
import {
	toCapabilityEndpointWithSecret,
	webhookEndpointWithSecretSchema,
} from './shared.ts'

export const webhookEndpointRotateSecretCapability = defineDomainCapability(
	capabilityDomainNames.webhooks,
	{
		name: 'webhook_endpoint_rotate_secret',
		description:
			'Rotate the URL secret for an inbound webhook endpoint and return the new full URL once. The previous URL stops working immediately. Treat the returned URL as a credential.',
		keywords: ['webhook', 'endpoint', 'rotate', 'secret', 'credential'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			id: z.string().min(1).describe('Webhook endpoint id.'),
		}),
		outputSchema: z.object({
			endpoint: webhookEndpointWithSecretSchema,
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const rotated = await rotateWebhookEndpointSecretForUser({
				env: ctx.env,
				userId: user.userId,
				email: user.email,
				username: user.username,
				endpointId: args.id,
				requestUrl: ctx.callerContext.baseUrl,
			})
			if (!rotated) {
				throw new Error('Webhook endpoint not found.')
			}
			return { endpoint: toCapabilityEndpointWithSecret(rotated) }
		},
	},
)
