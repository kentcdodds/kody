import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { systemEmailOwnerId } from './email-owner.ts'
import {
	mailboxMirrorRpcTimeoutMs,
	mirrorMailboxDeliveryEventSnapshot,
	mirrorMailboxDeliveryEventSnapshots,
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
	const writeDataPoint = vi.fn()
	return {
		env: {
			MAILBOX: {
				idFromName,
				get,
			} as unknown as DurableObjectNamespace,
			EMAIL_EVENTS: {
				writeDataPoint,
			} as unknown as AnalyticsEngineDataset,
		},
		idFromName,
		get,
		writeDataPoint,
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

	const { env, idFromName, writeDataPoint } = fakeMailboxEnv({
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

	// missing partial mutation is a distinct mirror outcome (not mirrored)
	expect(
		await mirrorMailboxSetMessageClassification({
			env,
			ownerId: 'user-aaa',
			messageId: 'msg-1',
			classification: 'quarantined',
			classificationReason: 'manual',
			updatedAt: '2026-07-01T14:00:00.000Z',
		}),
	).toEqual({ status: 'missing' })

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

	// delete missing remains mirrored — desired absence is achieved
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
			env: { EMAIL_EVENTS: env.EMAIL_EVENTS },
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

	const outcomes = writeDataPoint.mock.calls.map(
		(call) => (call[0] as { blobs: Array<string> }).blobs,
	)
	expect(outcomes).toContainEqual([
		'mailbox_mirror:mirror_message',
		'mirrored',
		expect.any(String),
	])
	expect(outcomes).toContainEqual([
		'mailbox_mirror:set_message_classification',
		'missing',
		expect.any(String),
	])
	expect(outcomes).toContainEqual([
		'mailbox_mirror:update_message_delivery',
		'stale',
		expect.any(String),
	])
	expect(outcomes).toContainEqual([
		'mailbox_mirror:delete_delivery_event',
		'error',
		expect.any(String),
	])
	expect(outcomes).toContainEqual([
		'mailbox_mirror:mirror_message',
		'skipped',
		expect.any(String),
	])
	// system email must not emit a parity data point
	expect(
		outcomes.filter(
			(blobs) =>
				blobs[0] === 'mailbox_mirror:mirror_message' && blobs[1] === 'skipped',
		),
	).toHaveLength(1)
})

test('mailbox mirror RPC timeout returns timeout and late rejection is not unhandled', async () => {
	vi.useFakeTimers()
	consoleWarn.mockImplementation(() => {})

	let rejectRpc!: (error: unknown) => void
	const mirrorMessage = vi.fn(
		() =>
			new Promise<{ ok: true; accepted: boolean }>((_resolve, reject) => {
				rejectRpc = reject
			}),
	)
	const { env, writeDataPoint } = fakeMailboxEnv({ mirrorMessage })

	const pending = mirrorMailboxMessageSnapshot({
		env,
		message: baseMessage(),
	})
	const expectation = expect(pending).resolves.toEqual({ status: 'timeout' })
	await vi.advanceTimersByTimeAsync(mailboxMirrorRpcTimeoutMs)
	await expectation

	expect(writeDataPoint).toHaveBeenCalledWith(
		expect.objectContaining({
			indexes: ['user-aaa'],
			blobs: ['mailbox_mirror:mirror_message', 'timeout', expect.any(String)],
		}),
	)

	const unhandled: Array<unknown> = []
	const onUnhandled = (reason: unknown) => {
		unhandled.push(reason)
	}
	process.on('unhandledRejection', onUnhandled)
	try {
		rejectRpc(new Error('late rejection after timeout'))
		await Promise.resolve()
		await Promise.resolve()
		expect(unhandled).toEqual([])
	} finally {
		process.off('unhandledRejection', onUnhandled)
		vi.useRealTimers()
	}
})

function baseDeliveryEventInput(
	overrides?: Partial<MailboxDeliveryEventInput>,
): MailboxDeliveryEventInput {
	return {
		id: 'evt-1',
		messageId: 'msg-1',
		inboxId: 'inbox-1',
		eventType: 'sent',
		provider: 'kody',
		providerMessageId: null,
		providerEventId: null,
		detailJson: '{}',
		needsEffectReconcile: false,
		state: null,
		fingerprint: null,
		storageLease: null,
		storageLeaseAt: null,
		cleanupLease: null,
		cleanupLeaseAt: null,
		cleanupRetryAt: null,
		expectedAttachmentCount: null,
		finalizationToken: null,
		reconcileAfter: null,
		dedupeExpiresAt: null,
		usageEffectRecordedAt: null,
		usageEffectSuppressedAt: null,
		usageStartedAt: null,
		usageMonth: null,
		usageBytes: null,
		usageDurationMs: null,
		usageEffectRetryAt: null,
		usageEffectLease: null,
		usageEffectLeaseAt: null,
		subscriptionEffectState: null,
		subscriptionEffectLease: null,
		subscriptionEffectLeaseAt: null,
		subscriptionEffectRetryAt: null,
		subscriptionEffectAttemptCount: null,
		subscriptionEffectDeadLetterAt: null,
		subscriptionEffectLastError: null,
		createdAt: '2026-07-02T10:00:00.000Z',
		updatedAt: '2026-07-02T10:00:00.000Z',
		...overrides,
	}
}

test('mailbox mirror batch helper uses one RPC, one telemetry outcome, and maps per-event results', async () => {
	consoleWarn.mockImplementation(() => {})
	const events = [
		baseDeliveryEventInput({ id: 'evt-a' }),
		baseDeliveryEventInput({
			id: 'evt-b',
			createdAt: '2026-07-02T10:00:01.000Z',
			updatedAt: '2026-07-02T10:00:01.000Z',
		}),
	]
	const upsertDeliveryEvents = vi.fn(async () => ({
		results: [
			{ eventId: 'evt-a', inserted: true, accepted: true },
			{ eventId: 'evt-b', inserted: false, accepted: false },
		],
	}))
	const { env, writeDataPoint } = fakeMailboxEnv({ upsertDeliveryEvents })

	await expect(
		mirrorMailboxDeliveryEventSnapshots({
			env,
			ownerId: 'user-aaa',
			events,
		}),
	).resolves.toEqual([
		{ eventId: 'evt-a', result: { status: 'mirrored' } },
		{ eventId: 'evt-b', result: { status: 'stale' } },
	])
	expect(upsertDeliveryEvents).toHaveBeenCalledTimes(1)
	expect(upsertDeliveryEvents).toHaveBeenCalledWith({
		ownerId: 'user-aaa',
		events,
	})
	expect(writeDataPoint).toHaveBeenCalledTimes(1)
	expect(writeDataPoint).toHaveBeenCalledWith(
		expect.objectContaining({
			blobs: [
				'mailbox_mirror:upsert_delivery_event_batch',
				'stale',
				expect.any(String),
			],
		}),
	)

	await expect(
		mirrorMailboxDeliveryEventSnapshots({
			env,
			ownerId: 'user-aaa',
			events: [],
		}),
	).resolves.toEqual([])
	expect(upsertDeliveryEvents).toHaveBeenCalledTimes(1)
})

test('mailbox mirror batch helper maps timeout and error to every event', async () => {
	vi.useFakeTimers()
	consoleWarn.mockImplementation(() => {})
	try {
		const events = [
			baseDeliveryEventInput({ id: 'evt-1' }),
			baseDeliveryEventInput({ id: 'evt-2' }),
		]
		const hang = vi.fn(() => new Promise<never>(() => {}))
		const { env: hangEnv, writeDataPoint: hangWrite } = fakeMailboxEnv({
			upsertDeliveryEvents: hang,
		})
		const pending = mirrorMailboxDeliveryEventSnapshots({
			env: hangEnv,
			ownerId: 'user-aaa',
			events,
		})
		const expectation = expect(pending).resolves.toEqual([
			{ eventId: 'evt-1', result: { status: 'timeout' } },
			{ eventId: 'evt-2', result: { status: 'timeout' } },
		])
		await vi.advanceTimersByTimeAsync(mailboxMirrorRpcTimeoutMs)
		await expectation
		expect(hangWrite).toHaveBeenCalledTimes(1)

		const fail = vi.fn(async () => {
			throw new Error('batch unavailable')
		})
		const { env: failEnv } = fakeMailboxEnv({ upsertDeliveryEvents: fail })
		await expect(
			mirrorMailboxDeliveryEventSnapshots({
				env: failEnv,
				ownerId: 'user-aaa',
				events,
			}),
		).resolves.toEqual([
			{
				eventId: 'evt-1',
				result: {
					status: 'error',
					error: expect.objectContaining({ message: 'batch unavailable' }),
				},
			},
			{
				eventId: 'evt-2',
				result: {
					status: 'error',
					error: expect.objectContaining({ message: 'batch unavailable' }),
				},
			},
		])
	} finally {
		vi.useRealTimers()
	}
})
