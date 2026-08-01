import { expect, test } from 'vitest'
import {
	type EmailAttachmentRecord,
	type EmailMessageRecord,
	type EmailThreadRecord,
} from './types.ts'
import {
	toMailboxAttachmentInput,
	toMailboxDeliveryEventInput,
	toMailboxMessageInput,
	toMailboxThreadInput,
	type EmailDeliveryEventMirrorProjection,
} from './mailbox-snapshots.ts'

test('D1→Mailbox snapshot converters normalize defaults and prefer D1 promoted columns', () => {
	const thread: EmailThreadRecord = {
		id: 'thread-1',
		userId: 'user-1',
		inboxId: 'inbox-1',
		subjectNormalized: null,
		rootMessageIdHeader: null,
		lastMessageAt: null,
		createdAt: '2026-07-01T12:00:00.000Z',
		updatedAt: '2026-07-01T12:30:00.000Z',
	}
	expect(toMailboxThreadInput(thread)).toEqual({
		id: 'thread-1',
		inboxId: 'inbox-1',
		subjectNormalized: '',
		rootMessageIdHeader: null,
		lastMessageAt: '2026-07-01T12:00:00.000Z',
		createdAt: '2026-07-01T12:00:00.000Z',
		updatedAt: '2026-07-01T12:30:00.000Z',
	})

	const message: EmailMessageRecord = {
		id: 'msg-1',
		direction: 'inbound',
		userId: 'user-1',
		inboxId: null,
		threadId: 'thread-1',
		senderIdentityId: null,
		fromAddress: null,
		envelopeFrom: null,
		toAddresses: ['owner@example.com'],
		ccAddresses: [],
		bccAddresses: [],
		replyToAddresses: [],
		subject: null,
		messageIdHeader: '<msg-1@example.com>',
		inReplyToHeader: null,
		references: [],
		headers: null,
		authResults: null,
		textBody: 'hello',
		htmlBody: null,
		rawMimeKey: 'user-1/msg-1.eml',
		rawSize: null,
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
	}
	expect(toMailboxMessageInput(message)).toEqual({
		id: 'msg-1',
		direction: 'inbound',
		inboxId: null,
		threadId: 'thread-1',
		senderIdentityId: null,
		fromAddress: '',
		envelopeFrom: null,
		toAddresses: ['owner@example.com'],
		ccAddresses: [],
		bccAddresses: [],
		replyToAddresses: [],
		subject: '',
		messageIdHeader: '<msg-1@example.com>',
		inReplyToHeader: null,
		references: [],
		headers: {},
		authResults: null,
		textBody: 'hello',
		htmlBody: null,
		rawMimeKey: 'user-1/msg-1.eml',
		rawSize: 0,
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
	})

	const attachment: EmailAttachmentRecord = {
		id: 'att-1',
		messageId: 'msg-1',
		filename: 'note.txt',
		contentType: null,
		contentId: null,
		disposition: null,
		size: 12,
		storageKind: 'external',
		storageKey: 'user-1/msg-1/att-1',
		createdAt: '2026-07-01T12:00:00.000Z',
	}
	expect(toMailboxAttachmentInput(attachment)).toEqual({
		id: 'att-1',
		messageId: 'msg-1',
		filename: 'note.txt',
		contentType: 'application/octet-stream',
		contentId: null,
		disposition: null,
		size: 12,
		storageKind: 'external',
		storageKey: 'user-1/msg-1/att-1',
		createdAt: '2026-07-01T12:00:00.000Z',
	})

	const detail = {
		state: 'received',
		fingerprint: 'fp-1',
		storageLease: 'lease-1',
		storageLeaseAt: '2026-07-02T10:00:00.000Z',
		cleanupLease: 'cleanup-1',
		cleanupLeaseAt: '2026-07-02T10:05:00.000Z',
		cleanupRetryAt: '2026-07-02T11:00:00.000Z',
		expectedAttachmentCount: 2,
		finalizationToken: 'token-1',
		reconcileAfter: '2026-07-02T12:00:00.000Z',
		dedupeExpiresAt: '2026-07-04T10:00:00.000Z',
		usageEffectRecordedAt: '2026-07-02T09:00:00.000Z',
		usageEffectSuppressedAt: null,
		usageStartedAt: '2026-07-02T09:59:00.000Z',
		usageMonth: 'stale-from-json',
		usageBytes: 1,
		usageDurationMs: 1,
		usageEffectRetryAt: null,
		usageEffectLease: 'usage-lease',
		usageEffectLeaseAt: '2026-07-02T10:00:30.000Z',
		subscriptionEffectState: 'pending',
		subscriptionEffectLease: 'sub-lease',
		subscriptionEffectLeaseAt: '2026-07-02T10:02:00.000Z',
		subscriptionEffectRetryAt: '2026-07-02T13:00:00.000Z',
		subscriptionEffectAttemptCount: 1,
		subscriptionEffectDeadLetterAt: null,
		subscriptionEffectLastError: null,
		recipient: 'owner@example.com',
	}
	const projection: EmailDeliveryEventMirrorProjection = {
		id: 'evt-1',
		messageId: 'msg-1',
		userId: 'user-1',
		inboxId: 'inbox-1',
		eventType: 'received',
		provider: null,
		providerMessageId: null,
		providerEventId: 'provider-evt-1',
		detailJson: JSON.stringify(detail),
		createdAt: '2026-07-02T10:00:00.000Z',
		needsEffectReconcile: true,
		usageEffectRecordedAt: '2026-07-02T10:01:00.000Z',
		usageMonth: '2026-07',
		usageBytes: 2048,
		usageDurationMs: 120,
	}
	expect(
		toMailboxDeliveryEventInput({
			projection,
			sourceMutationAt: '2026-07-02T10:00:01.000Z',
		}),
	).toEqual({
		id: 'evt-1',
		messageId: 'msg-1',
		inboxId: 'inbox-1',
		eventType: 'received',
		provider: 'kody',
		providerMessageId: null,
		providerEventId: 'provider-evt-1',
		detailJson: projection.detailJson,
		needsEffectReconcile: true,
		state: 'received',
		fingerprint: 'fp-1',
		storageLease: 'lease-1',
		storageLeaseAt: '2026-07-02T10:00:00.000Z',
		cleanupLease: 'cleanup-1',
		cleanupLeaseAt: '2026-07-02T10:05:00.000Z',
		cleanupRetryAt: '2026-07-02T11:00:00.000Z',
		expectedAttachmentCount: 2,
		finalizationToken: 'token-1',
		reconcileAfter: '2026-07-02T12:00:00.000Z',
		dedupeExpiresAt: '2026-07-04T10:00:00.000Z',
		usageEffectRecordedAt: '2026-07-02T10:01:00.000Z',
		usageEffectSuppressedAt: null,
		usageStartedAt: '2026-07-02T09:59:00.000Z',
		usageMonth: '2026-07',
		usageBytes: 2048,
		usageDurationMs: 120,
		usageEffectRetryAt: null,
		usageEffectLease: 'usage-lease',
		usageEffectLeaseAt: '2026-07-02T10:00:30.000Z',
		subscriptionEffectState: 'pending',
		subscriptionEffectLease: 'sub-lease',
		subscriptionEffectLeaseAt: '2026-07-02T10:02:00.000Z',
		subscriptionEffectRetryAt: '2026-07-02T13:00:00.000Z',
		subscriptionEffectAttemptCount: 1,
		subscriptionEffectDeadLetterAt: null,
		subscriptionEffectLastError: null,
		createdAt: '2026-07-02T10:00:00.000Z',
		updatedAt: '2026-07-02T10:00:01.000Z',
	})
})

test('D1→Mailbox delivery snapshot conversion fails clearly on invalid JSON or enums', () => {
	const sentinelSecret = 'SENTINEL_SECRET_DO_NOT_LEAK_9f3a2b1c'
	const baseProjection: EmailDeliveryEventMirrorProjection = {
		id: 'evt-bad',
		messageId: null,
		userId: 'user-1',
		inboxId: null,
		eventType: 'received',
		provider: 'kody',
		providerMessageId: null,
		providerEventId: null,
		detailJson: '{}',
		createdAt: '2026-07-02T10:00:00.000Z',
		needsEffectReconcile: false,
		usageEffectRecordedAt: null,
		usageMonth: null,
		usageBytes: null,
		usageDurationMs: null,
	}

	expect(() =>
		toMailboxDeliveryEventInput({
			projection: baseProjection,
			sourceMutationAt: '',
		}),
	).toThrow(/sourceMutationAt must be a non-empty string/)

	const invalidJsonDetail = `{not-json,"apiKey":"${sentinelSecret}"`
	expect(() =>
		toMailboxDeliveryEventInput({
			projection: { ...baseProjection, detailJson: invalidJsonDetail },
			sourceMutationAt: '2026-07-02T10:00:00.000Z',
		}),
	).toThrow(/detailJson is not valid JSON/)
	try {
		toMailboxDeliveryEventInput({
			projection: { ...baseProjection, detailJson: invalidJsonDetail },
			sourceMutationAt: '2026-07-02T10:00:00.000Z',
		})
	} catch (error) {
		expect(String(error)).not.toContain(sentinelSecret)
		expect(String(error)).toMatch(/payload is \d+ bytes/)
	}

	expect(() =>
		toMailboxDeliveryEventInput({
			projection: { ...baseProjection, detailJson: '[]' },
			sourceMutationAt: '2026-07-02T10:00:00.000Z',
		}),
	).toThrow(/detailJson must be a JSON object/)
	try {
		toMailboxDeliveryEventInput({
			projection: {
				...baseProjection,
				detailJson: JSON.stringify([sentinelSecret]),
			},
			sourceMutationAt: '2026-07-02T10:00:00.000Z',
		})
	} catch (error) {
		expect(String(error)).not.toContain(sentinelSecret)
		expect(String(error)).toMatch(/array \(1 items\)/)
	}

	expect(() =>
		toMailboxDeliveryEventInput({
			projection: {
				...baseProjection,
				detailJson: JSON.stringify({ state: 'not-a-state' }),
			},
			sourceMutationAt: '2026-07-02T10:00:00.000Z',
		}),
	).toThrow(/detail\.state is invalid/)
	try {
		toMailboxDeliveryEventInput({
			projection: {
				...baseProjection,
				detailJson: JSON.stringify({
					state: 'not-a-state',
					apiKey: sentinelSecret,
				}),
			},
			sourceMutationAt: '2026-07-02T10:00:00.000Z',
		})
	} catch (error) {
		expect(String(error)).not.toContain(sentinelSecret)
	}

	expect(() =>
		toMailboxDeliveryEventInput({
			projection: {
				...baseProjection,
				detailJson: JSON.stringify({
					subscriptionEffectState: 'bogus',
				}),
			},
			sourceMutationAt: '2026-07-02T10:00:00.000Z',
		}),
	).toThrow(/detail\.subscriptionEffectState is invalid/)

	expect(() =>
		toMailboxDeliveryEventInput({
			projection: {
				...baseProjection,
				detailJson: JSON.stringify({ expectedAttachmentCount: 'lots' }),
			},
			sourceMutationAt: '2026-07-02T10:00:00.000Z',
		}),
	).toThrow(/detail\.expectedAttachmentCount must be a finite number/)
	try {
		toMailboxDeliveryEventInput({
			projection: {
				...baseProjection,
				detailJson: JSON.stringify({
					expectedAttachmentCount: sentinelSecret,
				}),
			},
			sourceMutationAt: '2026-07-02T10:00:00.000Z',
		})
	} catch (error) {
		expect(String(error)).not.toContain(sentinelSecret)
		expect(String(error)).toMatch(/string \(\d+ chars\)/)
	}

	expect(() =>
		toMailboxDeliveryEventInput({
			projection: {
				...baseProjection,
				usageBytes: Number.NaN,
			},
			sourceMutationAt: '2026-07-02T10:00:00.000Z',
		}),
	).toThrow(/usageBytes must be a finite number/)

	expect(() =>
		toMailboxAttachmentInput({
			id: 'att-bad',
			messageId: 'msg-1',
			filename: null,
			contentType: 'text/plain',
			contentId: null,
			disposition: null,
			size: 1,
			storageKind: 'not-a-kind',
			storageKey: null,
			createdAt: '2026-07-01T12:00:00.000Z',
		}),
	).toThrow(/storageKind is invalid/)
})
