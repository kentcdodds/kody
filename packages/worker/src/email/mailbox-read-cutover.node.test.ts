import { expect, test, vi } from 'vitest'
import {
	getOwnerEmailAttachmentById,
	getOwnerEmailMessageById,
	isMailboxReadCutoverEnabled,
	listOwnerEmailAttachmentsForMessage,
	listOwnerEmailDeliveryEvents,
	listOwnerEmailMessages,
	listOwnerEmailMessagesPage,
	mailboxAttachmentToEmailAttachmentRecord,
	mailboxMessageToEmailMessageRecord,
	mailboxReadCutoverCheckedAtMaxAgeMs,
	mailboxReadCutoverFlagKey,
	mailboxReadCutoverSoakMs,
	searchOwnerEmailMessages,
	type MailboxReadCutoverMemo,
} from './mailbox-read-cutover.ts'
import {
	type MailboxAttachmentRecord,
	type MailboxMessageRecord,
} from './mailbox-types.ts'
import { type EmailMessageRecord } from './types.ts'

const {
	getEmailMessageByIdMock,
	listEmailMessagesMock,
	searchEmailMessagesMock,
	listEmailMessagesPageForUserMock,
	listEmailAttachmentsForUserMessageMock,
	getEmailAttachmentRecordByIdMock,
	listEmailDeliveryEventsMock,
	loadEmailAttachmentContentMock,
	recordFeatureFlagExposuresMock,
} = vi.hoisted(() => ({
	getEmailMessageByIdMock: vi.fn(),
	listEmailMessagesMock: vi.fn(),
	searchEmailMessagesMock: vi.fn(),
	listEmailMessagesPageForUserMock: vi.fn(),
	listEmailAttachmentsForUserMessageMock: vi.fn(),
	getEmailAttachmentRecordByIdMock: vi.fn(),
	listEmailDeliveryEventsMock: vi.fn(),
	loadEmailAttachmentContentMock: vi.fn(),
	recordFeatureFlagExposuresMock: vi.fn(),
}))

vi.mock('./repo.ts', () => ({
	getEmailMessageById: (...args: Array<unknown>) =>
		getEmailMessageByIdMock(...args),
	listEmailMessages: (...args: Array<unknown>) =>
		listEmailMessagesMock(...args),
	searchEmailMessages: (...args: Array<unknown>) =>
		searchEmailMessagesMock(...args),
	listEmailMessagesPageForUser: (...args: Array<unknown>) =>
		listEmailMessagesPageForUserMock(...args),
	listEmailAttachmentsForUserMessage: (...args: Array<unknown>) =>
		listEmailAttachmentsForUserMessageMock(...args),
	getEmailAttachmentRecordById: (...args: Array<unknown>) =>
		getEmailAttachmentRecordByIdMock(...args),
	listEmailDeliveryEvents: (...args: Array<unknown>) =>
		listEmailDeliveryEventsMock(...args),
}))

vi.mock('./service.ts', () => ({
	loadEmailAttachmentContent: (...args: Array<unknown>) =>
		loadEmailAttachmentContentMock(...args),
	loadRawMime: vi.fn(),
}))

vi.mock('#worker/feature-flags/exposure.ts', () => ({
	recordFeatureFlagExposures: (...args: Array<unknown>) =>
		recordFeatureFlagExposuresMock(...args),
}))

const nowIso = '2026-08-01T12:00:00.000Z'
const nowMs = Date.parse(nowIso)

function hoursAgoIso(hours: number) {
	return new Date(nowMs - hours * 60 * 60 * 1000).toISOString()
}

function hoursFromNowIso(hours: number) {
	return new Date(nowMs + hours * 60 * 60 * 1000).toISOString()
}

type ParityRow = {
	stable_user_id: string
	mailbox_parity_matching_since: string | null
	mailbox_parity_checked_at: string | null
	mailbox_parity_mismatch_count: number
}

type FlagState = {
	overrideEnabled: boolean | null
	globalEnabled: boolean | null
}

function createCutoverTestDb(input: {
	parityByUserId?: Map<number, ParityRow | null | 'error'>
	deletingUserIds?: ReadonlySet<number>
	flags?: FlagState
}) {
	const parityByUserId = input.parityByUserId ?? new Map()
	const deletingUserIds = input.deletingUserIds ?? new Set<number>()
	const flags: FlagState = input.flags ?? {
		overrideEnabled: null,
		globalEnabled: null,
	}

	function normalize(query: string) {
		return query.replace(/\s+/g, ' ').trim().toLowerCase()
	}

	function createStatement(query: string, params: Array<unknown> = []) {
		const normalized = normalize(query)
		return {
			bind(...nextParams: Array<unknown>) {
				return createStatement(query, nextParams)
			},
			async first<T>() {
				if (
					normalized.includes('from feature_flag_user_overrides') &&
					normalized.includes('where flag_key = ? and user_id = ?')
				) {
					expect(params[0]).toBe(mailboxReadCutoverFlagKey)
					if (flags.overrideEnabled === null) return null
					return { enabled: flags.overrideEnabled ? 1 : 0 } as T
				}
				if (
					normalized.includes('from feature_flags') &&
					normalized.includes('where key = ?')
				) {
					expect(params[0]).toBe(mailboxReadCutoverFlagKey)
					if (flags.globalEnabled === null) return null
					return {
						enabled: flags.globalEnabled ? 1 : 0,
						rollout_percent: null,
					} as T
				}
				if (
					normalized.includes('from users') &&
					normalized.includes('mailbox_parity_matching_since')
				) {
					expect(normalized).toContain('deleting_at is null')
					const userId = Number(params[0])
					if (deletingUserIds.has(userId)) return null
					const row = parityByUserId.get(userId)
					if (row === 'error') throw new Error('d1 parity read failed')
					if (row === undefined || row === null) return null
					return row as T
				}
				throw new Error(`Unsupported first query: ${query}`)
			},
		}
	}

	return {
		prepare(query: string) {
			return createStatement(query)
		},
	} as unknown as D1Database
}

function baseMailboxMessage(
	overrides?: Partial<MailboxMessageRecord>,
): MailboxMessageRecord {
	return {
		id: 'msg-1',
		direction: 'inbound',
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
		headers: { 'x-test': '1' },
		authResults: null,
		textBody: 'body',
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

function baseEmailMessage(
	overrides?: Partial<EmailMessageRecord>,
): EmailMessageRecord {
	return {
		...mailboxMessageToEmailMessageRecord(baseMailboxMessage(), 'user-aaa'),
		...overrides,
	}
}

function soakedParity(stableUserId = 'user-aaa'): ParityRow {
	return {
		stable_user_id: stableUserId,
		mailbox_parity_matching_since: hoursAgoIso(3),
		mailbox_parity_checked_at: hoursAgoIso(1),
		mailbox_parity_mismatch_count: 0,
	}
}

function fakeMailboxEnv(methods: Record<string, ReturnType<typeof vi.fn>>) {
	const idFromName = vi.fn((name: string) => name as unknown as DurableObjectId)
	const get = vi.fn(() => methods)
	return {
		env: {
			MAILBOX: {
				idFromName,
				get,
			} as unknown as DurableObjectNamespace,
		},
		idFromName,
		get,
		methods,
	}
}

test('mailbox-read-cutover soak is 2h; prior pass and young fail', async () => {
	expect(mailboxReadCutoverSoakMs).toBe(2 * 60 * 60 * 1000)
	const dbUserId = 7
	const stableUserId = 'user-aaa'

	const youngDb = createCutoverTestDb({
		flags: { overrideEnabled: true, globalEnabled: null },
		parityByUserId: new Map([
			[
				dbUserId,
				{
					...soakedParity(),
					mailbox_parity_matching_since: hoursAgoIso(1),
				},
			],
		]),
	})
	await expect(
		isMailboxReadCutoverEnabled({
			env: { APP_DB: youngDb },
			dbUserId,
			stableUserId,
			now: nowIso,
			skipExposureRecording: true,
		}),
	).resolves.toBe(false)

	const readyDb = createCutoverTestDb({
		flags: { overrideEnabled: true, globalEnabled: null },
		parityByUserId: new Map([[dbUserId, soakedParity()]]),
	})
	await expect(
		isMailboxReadCutoverEnabled({
			env: { APP_DB: readyDb },
			dbUserId,
			stableUserId,
			now: nowIso,
			skipExposureRecording: true,
		}),
	).resolves.toBe(true)

	const boundaryDb = createCutoverTestDb({
		flags: { overrideEnabled: null, globalEnabled: true },
		parityByUserId: new Map([
			[
				dbUserId,
				{
					stable_user_id: stableUserId,
					mailbox_parity_matching_since: new Date(
						nowMs - mailboxReadCutoverSoakMs,
					).toISOString(),
					mailbox_parity_checked_at: new Date(
						nowMs - mailboxReadCutoverCheckedAtMaxAgeMs,
					).toISOString(),
					mailbox_parity_mismatch_count: 0,
				},
			],
		]),
	})
	await expect(
		isMailboxReadCutoverEnabled({
			env: { APP_DB: boundaryDb },
			dbUserId,
			stableUserId,
			now: nowIso,
			skipExposureRecording: true,
		}),
	).resolves.toBe(true)
})

test('mailbox-read-cutover defaults off and keeps fresh6h/mismatch/error/deleting/identity fail closed', async () => {
	const dbUserId = 7
	const stableUserId = 'user-aaa'
	const d1Message = baseEmailMessage()
	getEmailMessageByIdMock.mockResolvedValue(d1Message)
	recordFeatureFlagExposuresMock.mockClear()

	const defaultOffDb = createCutoverTestDb({
		flags: { overrideEnabled: null, globalEnabled: null },
		parityByUserId: new Map([[dbUserId, soakedParity()]]),
	})
	await expect(
		isMailboxReadCutoverEnabled({
			env: { APP_DB: defaultOffDb },
			dbUserId,
			stableUserId,
			now: nowIso,
		}),
	).resolves.toBe(false)
	expect(recordFeatureFlagExposuresMock).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			stableUserId,
			evaluations: {
				[mailboxReadCutoverFlagKey]: {
					enabled: false,
					source: 'default',
				},
			},
		}),
	)

	const getMessage = vi.fn(async () => baseMailboxMessage())
	const { env: mailboxEnv, idFromName } = fakeMailboxEnv({ getMessage })
	await expect(
		getOwnerEmailMessageById({
			env: { ...mailboxEnv, APP_DB: defaultOffDb },
			dbUserId,
			stableUserId,
			messageId: 'msg-1',
			now: nowIso,
			skipExposureRecording: true,
		}),
	).resolves.toEqual(d1Message)
	expect(getEmailMessageByIdMock).toHaveBeenCalledWith({
		db: defaultOffDb,
		userId: stableUserId,
		messageId: 'msg-1',
	})
	expect(getMessage).not.toHaveBeenCalled()
	expect(idFromName).not.toHaveBeenCalled()

	const staleDb = createCutoverTestDb({
		flags: { overrideEnabled: true, globalEnabled: null },
		parityByUserId: new Map([
			[
				dbUserId,
				{
					...soakedParity(),
					mailbox_parity_checked_at: hoursAgoIso(7),
				},
			],
		]),
	})
	await expect(
		isMailboxReadCutoverEnabled({
			env: { APP_DB: staleDb },
			dbUserId,
			stableUserId,
			now: nowIso,
			skipExposureRecording: true,
		}),
	).resolves.toBe(false)

	const mismatchedDb = createCutoverTestDb({
		flags: { overrideEnabled: true, globalEnabled: null },
		parityByUserId: new Map([
			[
				dbUserId,
				{
					...soakedParity(),
					mailbox_parity_mismatch_count: 1,
				},
			],
		]),
	})
	await expect(
		isMailboxReadCutoverEnabled({
			env: { APP_DB: mismatchedDb },
			dbUserId,
			stableUserId,
			now: nowIso,
			skipExposureRecording: true,
		}),
	).resolves.toBe(false)

	const crossUserDb = createCutoverTestDb({
		flags: { overrideEnabled: true, globalEnabled: null },
		parityByUserId: new Map([[dbUserId, soakedParity('user-other')]]),
	})
	await expect(
		isMailboxReadCutoverEnabled({
			env: { APP_DB: crossUserDb },
			dbUserId,
			stableUserId,
			now: nowIso,
			skipExposureRecording: true,
		}),
	).resolves.toBe(false)

	const deletingDb = createCutoverTestDb({
		flags: { overrideEnabled: true, globalEnabled: null },
		parityByUserId: new Map([[dbUserId, soakedParity()]]),
		deletingUserIds: new Set([dbUserId]),
	})
	await expect(
		isMailboxReadCutoverEnabled({
			env: { APP_DB: deletingDb },
			dbUserId,
			stableUserId,
			now: nowIso,
			skipExposureRecording: true,
		}),
	).resolves.toBe(false)
})

test('mailbox-read-cutover DO on path covers list/search/get/attachment/events without D1 fallback', async () => {
	const dbUserId = 7
	const stableUserId = 'user-aaa'
	const readyDb = createCutoverTestDb({
		flags: { overrideEnabled: true, globalEnabled: null },
		parityByUserId: new Map([[dbUserId, soakedParity()]]),
	})
	const memo: MailboxReadCutoverMemo = {}
	const doMessage = baseMailboxMessage({ subject: 'From DO' })
	const attachment: MailboxAttachmentRecord = {
		id: 'att-1',
		messageId: 'msg-1',
		filename: 'note.txt',
		contentType: 'text/plain',
		contentId: null,
		disposition: 'attachment',
		size: 4,
		storageKind: 'raw-mime',
		storageKey: null,
		createdAt: '2026-07-01T12:00:00.000Z',
	}
	const methods = {
		getMessage: vi.fn(async () => doMessage),
		listMessages: vi.fn(async () => ({
			messages: [doMessage],
			nextCursor: null,
		})),
		searchMessages: vi.fn(async () => ({ messages: [doMessage] })),
		countMessages: vi.fn(async () => ({ total: 1 })),
		getAttachment: vi.fn(async () => attachment),
		listAttachmentsForMessage: vi.fn(async () => [attachment]),
		listDeliveryEvents: vi.fn(async () => [
			{
				id: 'evt-1',
				messageId: 'msg-1',
				inboxId: 'inbox-1',
				eventType: 'received' as const,
				provider: 'cloudflare',
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
				createdAt: '2026-07-01T12:00:00.000Z',
				updatedAt: '2026-07-01T12:00:00.000Z',
			},
		]),
	}
	const doEnv = fakeMailboxEnv(methods)
	const env = { ...doEnv.env, APP_DB: readyDb }
	const base = {
		env,
		dbUserId,
		stableUserId,
		now: nowIso,
		memo,
		skipExposureRecording: true,
	}

	getEmailMessageByIdMock.mockClear()
	listEmailMessagesMock.mockClear()
	searchEmailMessagesMock.mockClear()
	listEmailMessagesPageForUserMock.mockClear()
	listEmailDeliveryEventsMock.mockClear()
	getEmailAttachmentRecordByIdMock.mockClear()
	loadEmailAttachmentContentMock.mockResolvedValue({
		...mailboxAttachmentToEmailAttachmentRecord(attachment),
		contentBase64: 'YmxvYg==',
		content: null,
	})

	await expect(listOwnerEmailMessages({ ...base, limit: 10 })).resolves.toEqual(
		[mailboxMessageToEmailMessageRecord(doMessage, stableUserId)],
	)
	await expect(
		searchOwnerEmailMessages({ ...base, query: 'Hello', limit: 10 }),
	).resolves.toEqual([
		mailboxMessageToEmailMessageRecord(doMessage, stableUserId),
	])
	await expect(
		listOwnerEmailMessagesPage({
			...base,
			query: '',
			classification: null,
			pageSize: 10,
			offset: 0,
		}),
	).resolves.toEqual({
		total: 1,
		messages: [mailboxMessageToEmailMessageRecord(doMessage, stableUserId)],
	})
	await expect(
		getOwnerEmailMessageById({ ...base, messageId: 'msg-1' }),
	).resolves.toEqual(
		mailboxMessageToEmailMessageRecord(doMessage, stableUserId),
	)
	const events = await listOwnerEmailDeliveryEvents({
		...base,
		messageId: 'msg-1',
		limit: 5,
	})
	expect(events).toEqual([
		expect.objectContaining({
			id: 'evt-1',
			userId: stableUserId,
			messageId: 'msg-1',
			eventType: 'received',
		}),
	])
	expect(methods.listDeliveryEvents).toHaveBeenCalled()
	await expect(
		getOwnerEmailAttachmentById({
			...base,
			blobs: {} as R2Bucket,
			attachmentId: 'att-1',
		}),
	).resolves.toMatchObject({ id: 'att-1', contentBase64: 'YmxvYg==' })

	expect(doEnv.idFromName).toHaveBeenCalledWith(stableUserId)
	expect(getEmailMessageByIdMock).not.toHaveBeenCalled()
	expect(listEmailMessagesMock).not.toHaveBeenCalled()
	expect(searchEmailMessagesMock).not.toHaveBeenCalled()
	expect(listEmailMessagesPageForUserMock).not.toHaveBeenCalled()
	expect(listEmailDeliveryEventsMock).not.toHaveBeenCalled()
	expect(getEmailAttachmentRecordByIdMock).not.toHaveBeenCalled()
	expect(loadEmailAttachmentContentMock).toHaveBeenCalled()
})

test('mailbox-read-cutover does not fall back from DO and isolates cross-owner identity', async () => {
	const dbUserId = 7
	const stableUserId = 'user-aaa'
	const readyDb = createCutoverTestDb({
		flags: { overrideEnabled: true, globalEnabled: null },
		parityByUserId: new Map([[dbUserId, soakedParity()]]),
	})
	const failingGet = vi.fn(async () => {
		throw new Error('mailbox unavailable')
	})
	const failingEnv = fakeMailboxEnv({ getMessage: failingGet })
	getEmailMessageByIdMock.mockClear()
	await expect(
		getOwnerEmailMessageById({
			env: { ...failingEnv.env, APP_DB: readyDb },
			dbUserId,
			stableUserId,
			messageId: 'msg-1',
			now: nowIso,
			skipExposureRecording: true,
		}),
	).rejects.toThrow(/mailbox unavailable/)
	expect(getEmailMessageByIdMock).not.toHaveBeenCalled()

	const parityErrorDb = createCutoverTestDb({
		flags: { overrideEnabled: true, globalEnabled: null },
		parityByUserId: new Map([[dbUserId, 'error']]),
	})
	const d1Message = baseEmailMessage()
	getEmailMessageByIdMock.mockResolvedValue(d1Message)
	await expect(
		getOwnerEmailMessageById({
			env: {
				...fakeMailboxEnv({ getMessage: vi.fn() }).env,
				APP_DB: parityErrorDb,
			},
			dbUserId,
			stableUserId,
			messageId: 'msg-1',
			now: nowIso,
			skipExposureRecording: true,
		}),
	).resolves.toEqual(d1Message)

	await expect(
		isMailboxReadCutoverEnabled({
			env: { APP_DB: readyDb },
			dbUserId,
			stableUserId: 'user-other',
			now: nowIso,
			skipExposureRecording: true,
		}),
	).resolves.toBe(false)

	const attachment = {
		id: 'att-1',
		messageId: 'msg-1',
		filename: 'note.txt',
		contentType: 'text/plain',
		contentId: null,
		disposition: 'attachment',
		size: 12,
		storageKind: 'inline' as const,
		storageKey: null,
		createdAt: '2026-07-01T12:00:00.000Z',
	}
	listEmailAttachmentsForUserMessageMock.mockClear()
	listEmailAttachmentsForUserMessageMock.mockResolvedValue([])
	await expect(
		listOwnerEmailAttachmentsForMessage({
			env: {
				...fakeMailboxEnv({ listAttachmentsForMessage: vi.fn() }).env,
				APP_DB: parityErrorDb,
			},
			dbUserId,
			stableUserId: 'user-other',
			messageId: 'msg-1',
			now: nowIso,
			skipExposureRecording: true,
		}),
	).resolves.toEqual([])
	expect(listEmailAttachmentsForUserMessageMock).toHaveBeenCalledWith({
		db: parityErrorDb,
		userId: 'user-other',
		messageId: 'msg-1',
	})

	listEmailAttachmentsForUserMessageMock.mockClear()
	listEmailAttachmentsForUserMessageMock.mockResolvedValue([attachment])
	await expect(
		listOwnerEmailAttachmentsForMessage({
			env: {
				...fakeMailboxEnv({ listAttachmentsForMessage: vi.fn() }).env,
				APP_DB: parityErrorDb,
			},
			dbUserId,
			stableUserId,
			messageId: 'msg-1',
			now: nowIso,
			skipExposureRecording: true,
		}),
	).resolves.toEqual([attachment])
	expect(listEmailAttachmentsForUserMessageMock).toHaveBeenCalledWith({
		db: parityErrorDb,
		userId: stableUserId,
		messageId: 'msg-1',
	})
})

test('mailbox-read-cutover fails closed on invalid now and future parity timestamps', async () => {
	const dbUserId = 7
	const stableUserId = 'user-aaa'
	const readyDb = createCutoverTestDb({
		flags: { overrideEnabled: true, globalEnabled: null },
		parityByUserId: new Map([[dbUserId, soakedParity()]]),
	})

	await expect(
		isMailboxReadCutoverEnabled({
			env: { APP_DB: readyDb },
			dbUserId,
			stableUserId,
			now: 'not-a-timestamp',
			skipExposureRecording: true,
		}),
	).resolves.toBe(false)
	await expect(
		isMailboxReadCutoverEnabled({
			env: { APP_DB: readyDb },
			dbUserId,
			stableUserId,
			now: new Date(Number.NaN),
			skipExposureRecording: true,
		}),
	).resolves.toBe(false)

	const futureCheckedDb = createCutoverTestDb({
		flags: { overrideEnabled: true, globalEnabled: null },
		parityByUserId: new Map([
			[
				dbUserId,
				{
					...soakedParity(),
					mailbox_parity_checked_at: hoursFromNowIso(1),
				},
			],
		]),
	})
	await expect(
		isMailboxReadCutoverEnabled({
			env: { APP_DB: futureCheckedDb },
			dbUserId,
			stableUserId,
			now: nowIso,
			skipExposureRecording: true,
		}),
	).resolves.toBe(false)
})

test('mailboxMessageToEmailMessageRecord maps DO row with supplied stable userId', () => {
	const mapped = mailboxMessageToEmailMessageRecord(
		baseMailboxMessage({ id: 'msg-map' }),
		'user-xyz',
	)
	expect(mapped).toMatchObject({
		id: 'msg-map',
		userId: 'user-xyz',
		direction: 'inbound',
		subject: 'Hello',
		rawMimeKey: 'user-aaa/msg-1.eml',
	})
	expect(mapped).not.toHaveProperty('ownerId')
})

test('gate memo records exposure once', async () => {
	const dbUserId = 7
	const stableUserId = 'user-aaa'
	const readyDb = createCutoverTestDb({
		flags: { overrideEnabled: true, globalEnabled: null },
		parityByUserId: new Map([[dbUserId, soakedParity()]]),
	})
	recordFeatureFlagExposuresMock.mockClear()
	const memo: MailboxReadCutoverMemo = {}
	await isMailboxReadCutoverEnabled({
		env: { APP_DB: readyDb },
		dbUserId,
		stableUserId,
		now: nowIso,
		memo,
	})
	await isMailboxReadCutoverEnabled({
		env: { APP_DB: readyDb },
		dbUserId,
		stableUserId,
		now: nowIso,
		memo,
	})
	expect(recordFeatureFlagExposuresMock).toHaveBeenCalledTimes(1)
})
