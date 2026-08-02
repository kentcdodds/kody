import { isSystemEmailOwner, systemEmailOwnerId } from './email-owner.ts'
import { mailboxRpc, type MailboxEnv } from './mailbox-client.ts'
import {
	mailboxAttachmentToEmailAttachmentRecord,
	mailboxMessageToEmailMessageRecord,
} from './mailbox-record-mappers.ts'
import {
	type MailboxBlobReferencePage,
	type MailboxCountResult,
	type MailboxExportResult,
} from './mailbox-types.ts'
import {
	countEmailMessagesForUser,
	getEmailMessageById,
	listEmailAttachmentsForUserMessage,
} from './repo.ts'
import { type EmailAttachmentRecord, type EmailMessageRecord } from './types.ts'

/**
 * Internal product-reader chokepoint.
 *
 * USER metadata is authoritative in Mailbox and fails closed when its binding
 * or RPC is unavailable. The reserved `system:email` owner remains explicitly
 * D1-only. There is deliberately no feature flag or D1 fallback here.
 */
export type MailboxInternalReadEnv = MailboxEnv & {
	APP_DB: D1Database
}

function assertUserOwner(ownerId: string) {
	if (isSystemEmailOwner(ownerId)) {
		throw new Error('system:email has no Mailbox Durable Object.')
	}
}

export async function getInternalEmailMessageById(input: {
	env: MailboxInternalReadEnv
	ownerId: string
	messageId: string
}): Promise<EmailMessageRecord | null> {
	if (isSystemEmailOwner(input.ownerId)) {
		return await getEmailMessageById({
			db: input.env.APP_DB,
			userId: input.ownerId,
			messageId: input.messageId,
		})
	}
	const message = await mailboxRpc({
		env: input.env,
		userId: input.ownerId,
	}).getMessage({ messageId: input.messageId })
	return message
		? mailboxMessageToEmailMessageRecord(message, input.ownerId)
		: null
}

export async function listInternalEmailAttachmentsForMessage(input: {
	env: MailboxInternalReadEnv
	ownerId: string
	messageId: string
}): Promise<Array<EmailAttachmentRecord>> {
	if (isSystemEmailOwner(input.ownerId)) {
		return await listEmailAttachmentsForUserMessage({
			db: input.env.APP_DB,
			userId: input.ownerId,
			messageId: input.messageId,
		})
	}
	const attachments = await mailboxRpc({
		env: input.env,
		userId: input.ownerId,
	}).listAttachmentsForMessage({ messageId: input.messageId })
	return attachments.map(mailboxAttachmentToEmailAttachmentRecord)
}

export async function countInternalEmailMessages(input: {
	env: MailboxInternalReadEnv
	ownerId: string
}): Promise<number> {
	if (isSystemEmailOwner(input.ownerId)) {
		return await countInternalSystemEmailMessages({ env: input.env })
	}
	return await countInternalUserEmailMessages(input)
}

export async function countInternalUserEmailMessages(input: {
	env: MailboxEnv
	ownerId: string
}): Promise<number> {
	assertUserOwner(input.ownerId)
	const { total } = await mailboxRpc({
		env: input.env,
		userId: input.ownerId,
	}).countMessages({})
	return total
}

export async function countInternalSystemEmailMessages(input: {
	env: { APP_DB: D1Database }
}): Promise<number> {
	return await countEmailMessagesForUser({
		db: input.env.APP_DB,
		userId: systemEmailOwnerId,
	})
}

export async function exportInternalUserMailbox(input: {
	env: MailboxEnv
	ownerId: string
	pageSize?: number
	startAfter?: string | null
}): Promise<MailboxExportResult> {
	assertUserOwner(input.ownerId)
	return await mailboxRpc({
		env: input.env,
		userId: input.ownerId,
	}).exportMailbox({
		pageSize: input.pageSize,
		startAfter: input.startAfter,
	})
}

export async function countInternalUserMailboxRows(input: {
	env: MailboxEnv
	ownerId: string
}): Promise<MailboxCountResult> {
	assertUserOwner(input.ownerId)
	return await mailboxRpc({
		env: input.env,
		userId: input.ownerId,
	}).countMailbox()
}

export async function listInternalUserEmailBlobReferences(input: {
	env: MailboxEnv
	ownerId: string
	pageSize?: number
	startAfter?: string | null
}): Promise<MailboxBlobReferencePage> {
	assertUserOwner(input.ownerId)
	return await mailboxRpc({
		env: input.env,
		userId: input.ownerId,
	}).listBlobReferences({
		pageSize: input.pageSize,
		startAfter: input.startAfter,
	})
}
