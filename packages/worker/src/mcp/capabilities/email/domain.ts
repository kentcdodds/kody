import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { emailInboxCreateCapability } from './email-inbox-create.ts'
import { emailInboxListCapability } from './email-inbox-list.ts'
import { emailMessageGetCapability } from './email-message-get.ts'
import { emailMessageListCapability } from './email-message-list.ts'
import { emailPolicyGetCapability } from './email-policy-get.ts'
import { emailReplyCapability } from './email-reply.ts'
import { emailSendCapability } from './email-send.ts'
import { emailSenderApproveCapability } from './email-sender-approve.ts'
import { emailSenderRevokeCapability } from './email-sender-revoke.ts'

export const emailDomain = defineDomain({
	name: capabilityDomainNames.email,
	description:
		'Cloudflare-backed email primitives for creating inbox aliases, sending verified outbound mail, storing inbound messages, and enforcing sender policies.',
	keywords: ['email', 'mail', 'inbox', 'quarantine', 'sender policy'],
	capabilities: [
		emailInboxCreateCapability,
		emailInboxListCapability,
		emailMessageListCapability,
		emailMessageGetCapability,
		emailSendCapability,
		emailReplyCapability,
		emailSenderApproveCapability,
		emailSenderRevokeCapability,
		emailPolicyGetCapability,
	],
})
