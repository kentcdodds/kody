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
	description: 'Package-declared inbound webhooks with minted credential URLs.',
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
