import {
	type MailboxAttachmentRecord,
	type MailboxDeliveryEventRecord,
	type MailboxMessageRecord,
} from './mailbox-types.ts'
import {
	type EmailAttachmentRecord,
	type EmailDeliveryEventRecord,
	type EmailMessageRecord,
} from './types.ts'

/** Map an owner-bound Mailbox message to the shared product record shape. */
export function mailboxMessageToEmailMessageRecord(
	message: MailboxMessageRecord,
	userId: string,
): EmailMessageRecord {
	return {
		...message,
		userId,
	}
}

/** Map Mailbox attachment metadata to the shared product record shape. */
export function mailboxAttachmentToEmailAttachmentRecord(
	attachment: MailboxAttachmentRecord,
): EmailAttachmentRecord {
	return { ...attachment }
}

/** Map an owner-bound Mailbox event to the shared product record shape. */
export function mailboxDeliveryEventToEmailDeliveryEventRecord(
	event: MailboxDeliveryEventRecord,
	userId: string,
): EmailDeliveryEventRecord {
	return {
		id: event.id,
		messageId: event.messageId,
		userId,
		inboxId: event.inboxId,
		eventType: event.eventType,
		provider: event.provider,
		providerMessageId: event.providerMessageId,
		providerEventId: event.providerEventId,
		detailJson: event.detailJson,
		createdAt: event.createdAt,
	}
}
