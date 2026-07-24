import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { webhookDeliveryListCapability } from './webhook-delivery-list.ts'
import { webhookDisableCapability } from './webhook-disable.ts'
import { webhookEnableCapability } from './webhook-enable.ts'
import { webhookListCapability } from './webhook-list.ts'
import { webhookUrlMintCapability } from './webhook-url-mint.ts'
import { webhookUrlRotateCapability } from './webhook-url-rotate.ts'

export const webhooksDomain = defineDomain({
	name: capabilityDomainNames.webhooks,
	description:
		'Package-centered inbound webhooks declared in package.json#kody.webhooks. Declare a webhook bound to a package export, mint a credential URL with webhook_url_mint, then point Sentry/GitHub/Stripe (or any provider) at it. Verification secrets are named secret-store references, never inline values.',
	keywords: [
		'webhook',
		'inbound',
		'http callback',
		'package.json#kody.webhooks',
		'sentry',
		'github',
		'stripe',
		'signature',
		'hmac',
		'mint',
	],
	capabilities: [
		webhookListCapability,
		webhookUrlMintCapability,
		webhookUrlRotateCapability,
		webhookEnableCapability,
		webhookDisableCapability,
		webhookDeliveryListCapability,
	],
})
