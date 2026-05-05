export const emailDirectionValues = ['inbound', 'outbound'] as const
export type EmailDirection = (typeof emailDirectionValues)[number]

export const emailProcessingStatusValues = ['stored', 'sent', 'failed'] as const
export type EmailProcessingStatus = (typeof emailProcessingStatusValues)[number]

export const emailDeliveryEventTypeValues = [
	'receive_started',
	'received',
	'rejected',
	'send_requested',
	'sent',
	'failed',
] as const
export type EmailDeliveryEventType =
	(typeof emailDeliveryEventTypeValues)[number]

export type EmailMailbox = {
	name: string | null
	address: string
}

export type EmailAttachmentMetadata = {
	filename: string | null
	contentType: string
	contentId: string | null
	disposition: string | null
	size: number
}

export type ParsedInboundEmail = {
	envelopeFrom: string
	envelopeTo: string
	headerFrom: string | null
	to: Array<EmailMailbox>
	cc: Array<EmailMailbox>
	bcc: Array<EmailMailbox>
	replyTo: Array<EmailMailbox>
	subject: string | null
	messageId: string | null
	inReplyTo: string | null
	references: Array<string>
	headers: Record<string, Array<string>>
	authResults: string | null
	textBody: string | null
	htmlBody: string | null
	rawMime: string
	rawSize: number
	attachments: Array<EmailAttachmentMetadata>
	replyToken: string | null
}

export type EmailInboxRecord = {
	id: string
	userId: string
	packageId: string | null
	name: string
	description: string
	enabled: boolean
	createdAt: string
	updatedAt: string
}

export type EmailInboxAddressRecord = {
	id: string
	inboxId: string
	userId: string
	address: string
	localPart: string
	domain: string
	replyTokenHash: string | null
	enabled: boolean
	createdAt: string
	updatedAt: string
}

export type EmailSenderIdentityRecord = {
	id: string
	userId: string
	packageId: string | null
	email: string
	domain: string
	displayName: string | null
	status: 'pending' | 'verified' | 'disabled'
	verifiedAt: string | null
	createdAt: string
	updatedAt: string
}

export type EmailThreadRecord = {
	id: string
	userId: string
	inboxId: string | null
	subjectNormalized: string | null
	rootMessageIdHeader: string | null
	lastMessageAt: string | null
	createdAt: string
	updatedAt: string
}

export type EmailMessageRecord = {
	id: string
	direction: EmailDirection
	userId: string
	inboxId: string | null
	threadId: string | null
	senderIdentityId: string | null
	fromAddress: string | null
	envelopeFrom: string | null
	toAddresses: Array<unknown>
	ccAddresses: Array<unknown>
	bccAddresses: Array<unknown>
	replyToAddresses: Array<unknown>
	subject: string | null
	messageIdHeader: string | null
	inReplyToHeader: string | null
	references: Array<unknown>
	headers: Record<string, unknown> | null
	authResults: string | null
	textBody: string | null
	htmlBody: string | null
	rawMime: string | null
	rawSize: number | null
	processingStatus: EmailProcessingStatus
	providerMessageId: string | null
	error: string | null
	receivedAt: string | null
	sentAt: string | null
	createdAt: string
	updatedAt: string
}

export type EmailAttachmentRecord = {
	id: string
	messageId: string
	filename: string | null
	contentType: string | null
	contentId: string | null
	disposition: string | null
	size: number
	storageKind: string
	storageKey: string | null
	createdAt: string
}

export type EmailDeliveryEventRecord = {
	id: string
	messageId: string | null
	userId: string | null
	inboxId: string | null
	eventType: EmailDeliveryEventType
	provider: string | null
	providerMessageId: string | null
	detailJson: string
	createdAt: string
}
