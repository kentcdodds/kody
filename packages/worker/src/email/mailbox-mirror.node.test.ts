import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { systemEmailOwnerId } from './email-owner.ts'
import {
	mirrorMailboxDeliveryEventSnapshot,
	mirrorMailboxDeleteDeliveryEvent,
	mirrorMailboxDeleteMessageMetadata,
	mirrorMailboxDeleteThreadIfEmpty,
	mirrorMailboxMessageSnapshot,
	mirrorMailboxSetMessageClassification,
	mirrorMailboxTouchThread,
	mirrorMailboxUpdateMessageDelivery,
} from './mailbox-mirror.ts'
import { type EmailMessageRecord, type EmailThreadRecord } from './types.ts'
import { type MailboxDeliveryEventInput } from './mailbox-types.ts'

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
	const touchThread = vi.fn(async () => ({ status: 'accepted' as const }))
	const updateMessageDelivery = vi.fn(async () => ({
		status: 'stale' as const,
	}))
	const setMessageClassification = vi.fn(async () => ({
		status: 'missing' as const,
	}))
	const deleteMessageMetadata = vi.fn(
		async (input: { messageId: string; deletedAt: string }) => {
			if (input.messageId === 'missing-msg') {
				return { status: 'missing' as const }
			}
			if (input.deletedAt < '2026-07-01T12:00:00.000Z') {
				return { status: 'stale' as const }
			}
			return { status: 'deleted' as const }
		},
	)
	const deleteDeliveryEvent = vi.fn(async () => {
		throw new Error('do unavailable')
	})
	const deleteThreadIfEmpty = vi.fn(async () => ({
		status: 'missing' as const,
	}))

	const { env, idFromName } = fakeMailboxEnv({
		mirrorMessage,
		upsertDeliveryEvent,
		touchThread,
		updateMessageDelivery,
		setMessageClassification,
		deleteMessageMetadata,
		deleteDeliveryEvent,
		deleteThreadIfEmpty,
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

	const deliveryEvent: MailboxDeliveryEventInput = {
		id: 'evt-1',
		messageId: 'msg-1',
		inboxId: 'inbox-1',
		eventType: 'receive_started',
		provider: 'cloudflare-email-routing',
		providerMessageId: null,
		providerEventId: null,
		detailJson: JSON.stringify({
			state: 'storing',
			fingerprint: 'fp-mirror',
			storageLease: 'lease',
			subscriptionEffectState: 'processing',
		}),
		needsEffectReconcile: true,
		state: 'storing',
		fingerprint: 'fp-mirror',
		storageLease: 'lease',
		storageLeaseAt: null,
		cleanupLease: null,
		cleanupLeaseAt: null,
		cleanupRetryAt: null,
		expectedAttachmentCount: null,
		finalizationToken: null,
		reconcileAfter: null,
		dedupeExpiresAt: null,
		usageEffectRecordedAt: '2026-07-02T10:01:00.000Z',
		usageEffectSuppressedAt: null,
		usageStartedAt: null,
		usageMonth: '2026-07',
		usageBytes: 99,
		usageDurationMs: 50,
		usageEffectRetryAt: null,
		usageEffectLease: null,
		usageEffectLeaseAt: null,
		subscriptionEffectState: 'processing',
		subscriptionEffectLease: null,
		subscriptionEffectLeaseAt: null,
		subscriptionEffectRetryAt: null,
		subscriptionEffectAttemptCount: null,
		subscriptionEffectDeadLetterAt: null,
		subscriptionEffectLastError: null,
		createdAt: '2026-07-02T10:00:00.000Z',
		updatedAt: '2026-07-02T10:00:01.000Z',
	}
	expect(
		await mirrorMailboxDeliveryEventSnapshot({
			env,
			ownerId: 'user-aaa',
			event: deliveryEvent,
		}),
	).toEqual({ status: 'mirrored' })
	expect(upsertDeliveryEvent).toHaveBeenCalledWith({
		ownerId: 'user-aaa',
		event: deliveryEvent,
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

	// missing partial mutation is idempotent success for best-effort dual-write
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
		await mirrorMailboxDeleteThreadIfEmpty({
			env,
			ownerId: 'user-aaa',
			threadId: 'thread-1',
			deletedAt: '2026-07-01T16:00:00.000Z',
		}),
	).toEqual({ status: 'mirrored' })
	expect(deleteThreadIfEmpty).toHaveBeenCalledWith({
		ownerId: 'user-aaa',
		threadId: 'thread-1',
		deletedAt: '2026-07-01T16:00:00.000Z',
	})

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

	expect(
		await mirrorMailboxTouchThread({
			env,
			ownerId: '',
			threadId: 'thread-1',
			lastMessageAt: '2026-07-01T13:00:00.000Z',
			updatedAt: '2026-07-01T13:00:00.000Z',
		}),
	).toEqual({ status: 'skipped', reason: 'missing-owner' })
	expect(touchThread).toHaveBeenCalledTimes(1)
})
