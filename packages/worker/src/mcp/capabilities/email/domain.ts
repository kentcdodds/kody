import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { emailInboxCreateCapability } from './email-inbox-create.ts'
import { emailInboxListCapability } from './email-inbox-list.ts'
import { emailAttachmentGetCapability } from './email-attachment-get.ts'
import { emailMessageGetCapability } from './email-message-get.ts'
import { emailMessageListCapability } from './email-message-list.ts'
import { emailMessageSearchCapability } from './email-message-search.ts'
import { emailReplyCapability } from './email-reply.ts'
import { emailSendCapability } from './email-send.ts'
import { emailSenderIdentityVerifyCapability } from './email-sender-identity-verify.ts'
import { emailUsageGetCapability } from './email-usage-get.ts'

export const emailDomain = defineDomain({
	name: capabilityDomainNames.email,
	description:
		'Cloudflare-backed email primitives for creating inbox aliases, storing inbound messages, and sending verified outbound mail.',
	keywords: ['email', 'mail', 'inbox', 'routing', 'sender identity'],
	capabilities: [
		emailInboxCreateCapability,
		emailInboxListCapability,
		emailAttachmentGetCapability,
		emailMessageListCapability,
		emailMessageSearchCapability,
		emailMessageGetCapability,
		emailSendCapability,
		emailReplyCapability,
		emailSenderIdentityVerifyCapability,
		emailUsageGetCapability,
	],
})
