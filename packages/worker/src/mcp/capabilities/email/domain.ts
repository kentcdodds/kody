import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { emailInboxListCapability } from './email-inbox-list.ts'
import { emailAttachmentGetCapability } from './email-attachment-get.ts'
import { emailDeliveryEventListCapability } from './email-delivery-event-list.ts'
import { emailMessageGetCapability } from './email-message-get.ts'
import { emailMessageListCapability } from './email-message-list.ts'
import { emailMessageSearchCapability } from './email-message-search.ts'
import { emailReplyCapability } from './email-reply.ts'
import { emailSendCapability } from './email-send.ts'
import { emailUsageGetCapability } from './email-usage-get.ts'

export const emailDomain = defineDomain({
	name: capabilityDomainNames.email,
	description:
		'Cloudflare-backed email primitives for the automatic per-user inbox at {username}@<platform domain>: storing inbound messages, notify-self sends, and replies to stored mail.',
	keywords: ['email', 'mail', 'inbox', 'routing'],
	capabilities: [
		emailInboxListCapability,
		emailAttachmentGetCapability,
		emailDeliveryEventListCapability,
		emailMessageListCapability,
		emailMessageSearchCapability,
		emailMessageGetCapability,
		emailSendCapability,
		emailReplyCapability,
		emailUsageGetCapability,
	],
})
