import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { webhookDeliveryListCapability } from './webhook-delivery-list.ts'
import { webhookEndpointCreateCapability } from './webhook-endpoint-create.ts'
import { webhookEndpointDeleteCapability } from './webhook-endpoint-delete.ts'
import { webhookEndpointGetCapability } from './webhook-endpoint-get.ts'
import { webhookEndpointListCapability } from './webhook-endpoint-list.ts'
import { webhookEndpointRotateSecretCapability } from './webhook-endpoint-rotate-secret.ts'
import { webhookEndpointUpdateCapability } from './webhook-endpoint-update.ts'

export const webhooksDomain = defineDomain({
	name: capabilityDomainNames.webhooks,
	description:
		'User-owned inbound webhook endpoints that dispatch provider POST payloads to a bound saved-package export. Create an endpoint to get a one-time credential URL, then point Sentry, GitHub, Stripe, or any generic webhook sender at it.',
	keywords: [
		'webhook',
		'inbound',
		'http callback',
		'sentry',
		'github',
		'stripe',
		'signature',
		'hmac',
	],
	capabilities: [
		webhookEndpointCreateCapability,
		webhookEndpointListCapability,
		webhookEndpointGetCapability,
		webhookEndpointUpdateCapability,
		webhookEndpointRotateSecretCapability,
		webhookEndpointDeleteCapability,
		webhookDeliveryListCapability,
	],
})
