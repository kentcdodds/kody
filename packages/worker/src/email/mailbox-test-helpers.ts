import { env } from 'cloudflare:workers'
import { expect } from 'vitest'
import { mailboxDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import { emailAttachmentBlobKey, emailRawMimeKey } from './blob-keys.ts'
import { mailboxRpc, type MailboxEnv } from './mailbox-client.ts'
import {
	type MailboxAttachmentInput,
	type MailboxMessageInput,
	type MailboxThreadInput,
} from './mailbox-do.ts'

export function mailboxEnv(): MailboxEnv & { MAILBOX: DurableObjectNamespace } {
	const mailbox = (env as MailboxEnv).MAILBOX
	if (!mailbox) {
		throw new Error(
			'MAILBOX Durable Object binding is required for mailbox-do workers tests.',
		)
	}
	return { MAILBOX: mailbox }
}

export function stubFor(userId: string) {
	const { MAILBOX } = mailboxEnv()
	return MAILBOX.get(MAILBOX.idFromName(mailboxDurableObjectName(userId)))
}

export function rpcFor(userId: string) {
	return mailboxRpc({ env: mailboxEnv(), userId })
}

export function uniqueUserId(label: string) {
	return `mailbox-${label}-${crypto.randomUUID()}`
}

export async function assertMailboxThrows(
	pattern: RegExp,
	run: () => Promise<unknown>,
) {
	try {
		await run()
		throw new Error(`Expected mailbox RPC to throw matching ${pattern}`)
	} catch (error) {
		expect(String(error)).toMatch(pattern)
	}
}

export function baseThread(
	overrides?: Partial<MailboxThreadInput>,
): MailboxThreadInput {
	const id = overrides?.id ?? crypto.randomUUID()
	const at = overrides?.lastMessageAt ?? '2026-07-01T12:00:00.000Z'
	return {
		id,
		inboxId: 'inbox-1',
		subjectNormalized: 'hello',
		rootMessageIdHeader: `<root-${id}@example.com>`,
		lastMessageAt: at,
		createdAt: at,
		updatedAt: at,
		...overrides,
	}
}

export function baseMessage(
	ownerId: string,
	overrides?: Partial<MailboxMessageInput>,
): MailboxMessageInput {
	const id = overrides?.id ?? crypto.randomUUID()
	const at = overrides?.createdAt ?? '2026-07-01T12:00:00.000Z'
	const direction = overrides?.direction ?? 'inbound'
	const rawMimeKey =
		overrides?.rawMimeKey !== undefined
			? overrides.rawMimeKey
			: direction === 'outbound'
				? null
				: emailRawMimeKey(ownerId, id)
	return {
		inboxId: 'inbox-1',
		threadId: null,
		fromAddress: 'sender@example.com',
		envelopeFrom: 'envelope@example.com',
		toAddresses: ['owner@example.com'],
		subject: 'Hello mailbox',
		messageIdHeader: `<msg-${id}@example.com>`,
		rawSize: 128,
		processingStatus: 'stored',
		classification: 'accepted',
		receivedAt: at,
		createdAt: at,
		updatedAt: at,
		...overrides,
		id,
		direction,
		rawMimeKey,
	}
}

export function baseAttachment(
	ownerId: string,
	messageId: string,
	overrides?: Partial<MailboxAttachmentInput>,
): MailboxAttachmentInput {
	const id = overrides?.id ?? crypto.randomUUID()
	const storageKind = overrides?.storageKind ?? 'external'
	const storageKey =
		overrides?.storageKey !== undefined
			? overrides.storageKey
			: storageKind === 'external'
				? emailAttachmentBlobKey(ownerId, messageId, id)
				: null
	return {
		filename: 'note.txt',
		contentType: 'text/plain',
		size: 12,
		createdAt: '2026-07-01T12:00:00.000Z',
		...overrides,
		id,
		messageId,
		storageKind,
		storageKey,
	}
}
