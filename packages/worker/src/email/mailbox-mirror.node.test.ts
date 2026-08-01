import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { systemEmailOwnerId } from './email-owner.ts'
import {
	mirrorMailboxDeliveryEventSnapshot,
	mirrorMailboxDeleteDeliveryEvent,
	mirrorMailboxDeleteMessageMetadata,
	mirrorMailboxMessageSnapshot,
	mirrorMailboxSetMessageClassification,
	mirrorMailboxTouchThread,
	mirrorMailboxUpdateMessageDelivery,
} from './mailbox-mirror.ts'
import {
	type EmailDeliveryEventRecord,
	type EmailMessageRecord,
	type EmailThreadRecord,
} from './types.ts'

function fakeMailboxEnv(stub: Record<string, unknown>) {
	const idFromName = vi.fn((name: string) => name as unknown as DurableObjectId)
	const get = vi.fn(() => stub)
	return {
		env: {
			MAILBOX: {
				idFromName,
				get,
			} as unknown as DurableObjectNamespace,
		},
		idFromName,
		get,
	}
}

function baseMessage(
	overrides?: Partial<EmailMessageRecord>,
): EmailMessageRecord {
	return {
		id: 'msg-1',
		direction: 'inbound',
		userId: 'user-aaa',
		inboxId: 'inbox-1',
		threadId: 'thread-1',
		senderIdentityId: null,
		fromAddress: 'sender@example.com',
		envelopeFrom: null,
		toAddresses: ['owner@example.com'],
		ccAddresses: [],
		bccAddresses: [],
		replyToAddresses: [],
		subject: 'Hello',
		messageIdHeader: '<msg-1@example.com>',
		inReplyToHeader: null,
		references: [],
		headers: {},
		authResults: null,
		textBody: null,
		htmlBody: null,
		rawMimeKey: 'user-aaa/msg-1.eml',
		rawSize: 32,
		processingStatus: 'stored',
		classification: 'accepted',
		classificationReason: null,
		providerMessageId: null,
		deliveryStatus: null,
		deliveryStatusAt: null,
		error: null,
		receivedAt: '2026-07-01T12:00:00.000Z',
		sentAt: null,
		createdAt: '2026-07-01T12:00:00.000Z',
		updatedAt: '2026-07-01T12:00:00.000Z',
		...overrides,
	}
}

test('mailbox mirror helpers scope by user idFromName, convert payloads, and report stale/skip/error', async () => {
	consoleWarn.mockImplementation(() => {})

	const mirrorMessage = vi.fn(async () => ({
		ok: true as const,
		accepted: true,
	}))
	const upsertDeliveryEvent = vi.fn(async () => ({
		inserted: true,
		accepted: true,
		updatedLatestStatus: false,
	}))
	const touchThread = vi.fn(async () => ({ accepted: true }))
	const updateMessageDelivery = vi.fn(async () => ({ accepted: false }))
	const setMessageClassification = vi.fn(async () => ({ accepted: true }))
	const deleteMessageMetadata = vi.fn(
		async (input: { messageId: string; deletedAt: string }) => {
			if (input.messageId === 'missing-msg') {
				return { deleted: false as const, stale: false as const }
			}
			if (input.deletedAt < '2026-07-01T12:00:00.000Z') {
				return { deleted: false as const, stale: true as const }
			}
			return {
				deleted: true as const,
				stale: false as const,
				orphanThreadDeleted: false,
			}
		},
	)
	const deleteDeliveryEvent = vi.fn(async () => {
		throw new Error('do unavailable')
	})

	const { env, idFromName } = fakeMailboxEnv({
		mirrorMessage,
		upsertDeliveryEvent,
		touchThread,
		updateMessageDelivery,
		setMessageClassification,
		deleteMessageMetadata,
		deleteDeliveryEvent,
	})

	const thread: EmailThreadRecord = {
		id: 'thread-1',
		userId: 'user-aaa',
		inboxId: 'inbox-1',
		subjectNormalized: null,
		rootMessageIdHeader: '<root@example.com>',
		lastMessageAt: '2026-07-01T12:00:00.000Z',
		createdAt: '2026-07-01T12:00:00.000Z',
		updatedAt: '2026-07-01T12:00:00.000Z',
	}
	const message = baseMessage()

	expect(
		await mirrorMailboxMessageSnapshot({
			env,
			thread,
			message,
			attachments: [
				{
					id: 'att-1',
					messageId: 'msg-1',
					filename: null,
					contentType: null,
					contentId: null,
					disposition: null,
					size: 0,
					storageKind: 'unavailable',
					storageKey: null,
					createdAt: '2026-07-01T12:00:00.000Z',
				},
			],
		}),
	).toEqual({ status: 'mirrored' })
	expect(idFromName).toHaveBeenCalledWith('user-aaa')
	expect(mirrorMessage).toHaveBeenCalledWith({
		ownerId: 'user-aaa',
		thread: {
			id: 'thread-1',
			inboxId: 'inbox-1',
			subjectNormalized: '',
			rootMessageIdHeader: '<root@example.com>',
			lastMessageAt: '2026-07-01T12:00:00.000Z',
			createdAt: '2026-07-01T12:00:00.000Z',
			updatedAt: '2026-07-01T12:00:00.000Z',
		},
		message: expect.objectContaining({
			id: 'msg-1',
			fromAddress: 'sender@example.com',
			subject: 'Hello',
			rawSize: 32,
			headers: {},
		}),
		attachments: [
			expect.objectContaining({
				id: 'att-1',
				contentType: 'application/octet-stream',
				storageKind: 'unavailable',
			}),
		],
	})

	const detail = {
		state: 'storing',
		fingerprint: 'fp-mirror',
		storageLease: 'lease',
		subscriptionEffectState: 'processing',
		// Stale JSON copies of promoted columns — must not win.
		usageEffectRecordedAt: '2026-01-01T00:00:00.000Z',
		usageMonth: 'json-month',
		usageBytes: 1,
		usageDurationMs: 1,
	}
	const event: EmailDeliveryEventRecord = {
		id: 'evt-1',
		messageId: 'msg-1',
		userId: 'user-aaa',
		inboxId: 'inbox-1',
		eventType: 'receive_started',
		provider: 'cloudflare-email-routing',
		providerMessageId: null,
		providerEventId: null,
		detailJson: JSON.stringify(detail),
		createdAt: '2026-07-02T10:00:00.000Z',
	}
	expect(
		await mirrorMailboxDeliveryEventSnapshot({
			env,
			snapshot: {
				event,
				updatedAt: '2026-07-02T10:00:01.000Z',
				needsEffectReconcile: true,
				usageEffectRecordedAt: '2026-07-02T10:01:00.000Z',
				usageMonth: '2026-07',
				usageBytes: 99,
				usageDurationMs: 50,
			},
		}),
	).toEqual({ status: 'mirrored' })
	expect(upsertDeliveryEvent).toHaveBeenCalledWith({
		ownerId: 'user-aaa',
		event: expect.objectContaining({
			id: 'evt-1',
			provider: 'cloudflare-email-routing',
			needsEffectReconcile: true,
			state: 'storing',
			fingerprint: 'fp-mirror',
			storageLease: 'lease',
			subscriptionEffectState: 'processing',
			usageEffectRecordedAt: '2026-07-02T10:01:00.000Z',
			usageMonth: '2026-07',
			usageBytes: 99,
			usageDurationMs: 50,
			updatedAt: '2026-07-02T10:00:01.000Z',
		}),
		latestDeliveryStatus: undefined,
	})

	expect(
		await mirrorMailboxTouchThread({
			env,
			ownerId: 'user-aaa',
			threadId: 'thread-1',
			lastMessageAt: '2026-07-01T13:00:00.000Z',
			updatedAt: '2026-07-01T13:00:00.000Z',
		}),
	).toEqual({ status: 'mirrored' })
	expect(touchThread).toHaveBeenCalledWith({
		ownerId: 'user-aaa',
		threadId: 'thread-1',
		lastMessageAt: '2026-07-01T13:00:00.000Z',
		updatedAt: '2026-07-01T13:00:00.000Z',
	})

	expect(
		await mirrorMailboxUpdateMessageDelivery({
			env,
			ownerId: 'user-aaa',
			messageId: 'msg-1',
			processingStatus: 'sent',
			providerMessageId: 'prov-1',
			error: null,
			sentAt: '2026-07-01T13:00:00.000Z',
			updatedAt: '2026-07-01T13:00:00.000Z',
		}),
	).toEqual({ status: 'stale' })

	expect(
		await mirrorMailboxSetMessageClassification({
			env,
			ownerId: 'user-aaa',
			messageId: 'msg-1',
			classification: 'quarantined',
			classificationReason: 'manual',
			updatedAt: '2026-07-01T14:00:00.000Z',
		}),
	).toEqual({ status: 'mirrored' })

	expect(
		await mirrorMailboxDeleteMessageMetadata({
			env,
			ownerId: 'user-aaa',
			messageId: 'msg-1',
			deletedAt: '2026-07-01T15:00:00.000Z',
		}),
	).toEqual({ status: 'mirrored' })

	expect(
		await mirrorMailboxDeleteMessageMetadata({
			env,
			ownerId: 'user-aaa',
			messageId: 'msg-1',
			deletedAt: '2026-07-01T11:00:00.000Z',
		}),
	).toEqual({ status: 'stale' })

	expect(
		await mirrorMailboxDeleteMessageMetadata({
			env,
			ownerId: 'user-aaa',
			messageId: 'missing-msg',
			deletedAt: '2026-07-01T15:00:00.000Z',
		}),
	).toEqual({ status: 'mirrored' })

	expect(
		await mirrorMailboxDeleteDeliveryEvent({
			env,
			ownerId: 'user-aaa',
			eventId: 'evt-1',
			deletedAt: '2026-07-02T11:00:00.000Z',
		}),
	).toEqual({
		status: 'error',
		error: expect.objectContaining({ message: 'do unavailable' }),
	})
	expect(consoleWarn).toHaveBeenCalledWith(
		'mailbox-mirror-delete-delivery-event-failed',
		expect.objectContaining({ message: 'do unavailable' }),
	)

	expect(
		await mirrorMailboxMessageSnapshot({
			env,
			message: baseMessage({ userId: systemEmailOwnerId }),
		}),
	).toEqual({ status: 'skipped', reason: 'system-email' })
	expect(mirrorMessage).toHaveBeenCalledTimes(1)

	expect(
		await mirrorMailboxMessageSnapshot({
			env: {},
			message: baseMessage(),
		}),
	).toEqual({ status: 'skipped', reason: 'mailbox-unconfigured' })
})
