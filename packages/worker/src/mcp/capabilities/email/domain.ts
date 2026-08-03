import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { emailInboxListCapability } from './email-inbox-list.ts'
import { emailAttachmentGetCapability } from './email-attachment-get.ts'
import { emailDeliveryEventListCapability } from './email-delivery-event-list.ts'
import { emailMessageClassifyCapability } from './email-message-classify.ts'
import { emailMessageGetCapability } from './email-message-get.ts'
import { emailMessageListCapability } from './email-message-list.ts'
import { emailMessageSearchCapability } from './email-message-search.ts'
import { emailReplyCapability } from './email-reply.ts'
import { emailSendCapability } from './email-send.ts'
import { emailSenderRuleDeleteCapability } from './email-sender-rule-delete.ts'
import { emailSenderRuleListCapability } from './email-sender-rule-list.ts'
import { emailSenderRuleSetCapability } from './email-sender-rule-set.ts'
import { emailUsageGetCapability } from './email-usage-get.ts'

export const emailDomain = defineDomain({
	name: capabilityDomainNames.email,
	description: 'Per-user inbox primitives for store, notify-self, and reply.',
	keywords: ['email', 'mail', 'inbox', 'routing'],
	capabilities: [
		emailInboxListCapability,
		emailAttachmentGetCapability,
		emailDeliveryEventListCapability,
		emailMessageListCapability,
		emailMessageSearchCapability,
		emailMessageGetCapability,
		emailMessageClassifyCapability,
		emailSenderRuleListCapability,
		emailSenderRuleSetCapability,
		emailSenderRuleDeleteCapability,
		emailSendCapability,
		emailReplyCapability,
		emailUsageGetCapability,
	],
})
