import { expect, test, vi } from 'vitest'
import {
	getOwnerEmailMessageById,
	isMailboxReadCutoverEnabled,
	mailboxMessageToEmailMessageRecord,
	mailboxReadCutoverCheckedAtMaxAgeMs,
	mailboxReadCutoverFlagKey,
	mailboxReadCutoverSoakMs,
} from './mailbox-read-cutover.ts'
import { type MailboxMessageRecord } from './mailbox-types.ts'
import { type EmailMessageRecord } from './types.ts'

const { getEmailMessageByIdMock } = vi.hoisted(() => ({
	getEmailMessageByIdMock: vi.fn(),
}))

vi.mock('./repo.ts', () => ({
	getEmailMessageById: (...args: Array<unknown>) =>
		getEmailMessageByIdMock(...args),
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
		mailbox_parity_matching_since: hoursAgoIso(30),
		mailbox_parity_checked_at: hoursAgoIso(1),
		mailbox_parity_mismatch_count: 0,
	}
}

function fakeMailboxEnv(getMessage: ReturnType<typeof vi.fn>) {
	const idFromName = vi.fn((name: string) => name as unknown as DurableObjectId)
	const get = vi.fn(() => ({ getMessage }))
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

test('mailbox-read-cutover defaults off and requires soak + fresh zero-mismatch parity', async () => {
	const dbUserId = 7
	const stableUserId = 'user-aaa'
	const d1Message = baseEmailMessage()
	getEmailMessageByIdMock.mockResolvedValue(d1Message)

	// Registry default: flag off → D1, even with soaked parity.
	const defaultOffDb = createCutoverTestDb({
		flags: { overrideEnabled: null, globalEnabled: null },
		parityByUserId: new Map([[dbUserId, soakedParity()]]),
	})
	await expect(
		isMailboxReadCutoverEnabled({
			db: defaultOffDb,
			dbUserId,
			stableUserId,
			now: nowIso,
		}),
	).resolves.toBe(false)

	const getMessage = vi.fn(async () => baseMailboxMessage())
	const { env: mailboxEnv, idFromName } = fakeMailboxEnv(getMessage)
	await expect(
		getOwnerEmailMessageById({
			env: { ...mailboxEnv, APP_DB: defaultOffDb },
			dbUserId,
			stableUserId,
			messageId: 'msg-1',
			now: nowIso,
		}),
	).resolves.toEqual(d1Message)
	expect(getEmailMessageByIdMock).toHaveBeenCalledWith({
		db: defaultOffDb,
		userId: stableUserId,
		messageId: 'msg-1',
	})
	expect(getMessage).not.toHaveBeenCalled()
	expect(idFromName).not.toHaveBeenCalled()

	// Override/global on but no parity → still D1.
	for (const flags of [
		{ overrideEnabled: true as boolean | null, globalEnabled: null },
		{ overrideEnabled: null, globalEnabled: true as boolean | null },
	]) {
		getEmailMessageByIdMock.mockClear()
		const noParityDb = createCutoverTestDb({
			flags,
			parityByUserId: new Map([[dbUserId, null]]),
		})
		await expect(
			isMailboxReadCutoverEnabled({
				db: noParityDb,
				dbUserId,
				stableUserId,
				now: nowIso,
			}),
		).resolves.toBe(false)
		await expect(
			getOwnerEmailMessageById({
				env: { ...mailboxEnv, APP_DB: noParityDb },
				dbUserId,
				stableUserId,
				messageId: 'msg-1',
				now: nowIso,
			}),
		).resolves.toEqual(d1Message)
		expect(getEmailMessageByIdMock).toHaveBeenCalled()
	}

	// Young matching_since (< 24h soak).
	const youngDb = createCutoverTestDb({
		flags: { overrideEnabled: true, globalEnabled: null },
		parityByUserId: new Map([
			[
				dbUserId,
				{
					...soakedParity(),
					mailbox_parity_matching_since: hoursAgoIso(23),
				},
			],
		]),
	})
	await expect(
		isMailboxReadCutoverEnabled({
			db: youngDb,
			dbUserId,
			stableUserId,
			now: nowIso,
		}),
	).resolves.toBe(false)

	// Stale checked_at (> 6h freshness window).
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
			db: staleDb,
			dbUserId,
			stableUserId,
			now: nowIso,
		}),
	).resolves.toBe(false)

	// Mismatch count blocks cutover.
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
			db: mismatchedDb,
			dbUserId,
			stableUserId,
			now: nowIso,
		}),
	).resolves.toBe(false)

	// Cross-user parity row denied (stable_user_id must match exactly).
	const crossUserDb = createCutoverTestDb({
		flags: { overrideEnabled: true, globalEnabled: null },
		parityByUserId: new Map([[dbUserId, soakedParity('user-other')]]),
	})
	await expect(
		isMailboxReadCutoverEnabled({
			db: crossUserDb,
			dbUserId,
			stableUserId,
			now: nowIso,
		}),
	).resolves.toBe(false)

	// Soaked + fresh + flag on → Mailbox DO; maps userId from the caller.
	const readyDb = createCutoverTestDb({
		flags: { overrideEnabled: true, globalEnabled: null },
		parityByUserId: new Map([[dbUserId, soakedParity()]]),
	})
	await expect(
		isMailboxReadCutoverEnabled({
			db: readyDb,
			dbUserId,
			stableUserId,
			now: nowIso,
		}),
	).resolves.toBe(true)

	getEmailMessageByIdMock.mockClear()
	const doMessage = baseMailboxMessage({ subject: 'From DO' })
	const doGetMessage = vi.fn(async () => doMessage)
	const doEnv = fakeMailboxEnv(doGetMessage)
	await expect(
		getOwnerEmailMessageById({
			env: { ...doEnv.env, APP_DB: readyDb },
			dbUserId,
			stableUserId,
			messageId: 'msg-1',
			now: nowIso,
		}),
	).resolves.toEqual(
		mailboxMessageToEmailMessageRecord(doMessage, stableUserId),
	)
	expect(doEnv.idFromName).toHaveBeenCalledWith(stableUserId)
	expect(doGetMessage).toHaveBeenCalledWith({ messageId: 'msg-1' })
	expect(getEmailMessageByIdMock).not.toHaveBeenCalled()

	// Boundary: matching_since exactly soak age and checked_at exactly max age.
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
			db: boundaryDb,
			dbUserId,
			stableUserId,
			now: nowIso,
		}),
	).resolves.toBe(true)
})

test('mailbox-read-cutover keeps deleting accounts on D1 even when otherwise eligible', async () => {
	const dbUserId = 7
	const stableUserId = 'user-aaa'
	const d1Message = baseEmailMessage()
	getEmailMessageByIdMock.mockResolvedValue(d1Message)

	const deletingDb = createCutoverTestDb({
		flags: { overrideEnabled: true, globalEnabled: null },
		parityByUserId: new Map([[dbUserId, soakedParity()]]),
		deletingUserIds: new Set([dbUserId]),
	})
	await expect(
		isMailboxReadCutoverEnabled({
			db: deletingDb,
			dbUserId,
			stableUserId,
			now: nowIso,
		}),
	).resolves.toBe(false)

	const getMessage = vi.fn(async () => baseMailboxMessage())
	const { env, idFromName } = fakeMailboxEnv(getMessage)
	await expect(
		getOwnerEmailMessageById({
			env: { ...env, APP_DB: deletingDb },
			dbUserId,
			stableUserId,
			messageId: 'msg-1',
			now: nowIso,
		}),
	).resolves.toEqual(d1Message)
	expect(getEmailMessageByIdMock).toHaveBeenCalledWith({
		db: deletingDb,
		userId: stableUserId,
		messageId: 'msg-1',
	})
	expect(getMessage).not.toHaveBeenCalled()
	expect(idFromName).not.toHaveBeenCalled()
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
			db: readyDb,
			dbUserId,
			stableUserId,
			now: 'not-a-timestamp',
		}),
	).resolves.toBe(false)
	await expect(
		isMailboxReadCutoverEnabled({
			db: readyDb,
			dbUserId,
			stableUserId,
			now: new Date(Number.NaN),
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
			db: futureCheckedDb,
			dbUserId,
			stableUserId,
			now: nowIso,
		}),
	).resolves.toBe(false)

	const futureMatchingDb = createCutoverTestDb({
		flags: { overrideEnabled: true, globalEnabled: null },
		parityByUserId: new Map([
			[
				dbUserId,
				{
					...soakedParity(),
					mailbox_parity_matching_since: hoursFromNowIso(1),
					mailbox_parity_checked_at: hoursAgoIso(1),
				},
			],
		]),
	})
	await expect(
		isMailboxReadCutoverEnabled({
			db: futureMatchingDb,
			dbUserId,
			stableUserId,
			now: nowIso,
		}),
	).resolves.toBe(false)
})

test('mailbox-read-cutover fails closed on D1 parity errors and does not fall back from DO', async () => {
	const dbUserId = 7
	const stableUserId = 'user-aaa'
	const d1Message = baseEmailMessage()
	getEmailMessageByIdMock.mockResolvedValue(d1Message)

	const parityErrorDb = createCutoverTestDb({
		flags: { overrideEnabled: true, globalEnabled: null },
		parityByUserId: new Map([[dbUserId, 'error']]),
	})
	await expect(
		isMailboxReadCutoverEnabled({
			db: parityErrorDb,
			dbUserId,
			stableUserId,
			now: nowIso,
		}),
	).resolves.toBe(false)
	const getMessage = vi.fn(async () => baseMailboxMessage())
	const { env } = fakeMailboxEnv(getMessage)
	await expect(
		getOwnerEmailMessageById({
			env: { ...env, APP_DB: parityErrorDb },
			dbUserId,
			stableUserId,
			messageId: 'msg-1',
			now: nowIso,
		}),
	).resolves.toEqual(d1Message)
	expect(getMessage).not.toHaveBeenCalled()
	expect(getEmailMessageByIdMock).toHaveBeenCalled()

	// When cutover is on, DO errors propagate — no silent D1 fallback.
	getEmailMessageByIdMock.mockClear()
	const readyDb = createCutoverTestDb({
		flags: { overrideEnabled: true, globalEnabled: null },
		parityByUserId: new Map([[dbUserId, soakedParity()]]),
	})
	const failingGet = vi.fn(async () => {
		throw new Error('mailbox unavailable')
	})
	const failingEnv = fakeMailboxEnv(failingGet)
	await expect(
		getOwnerEmailMessageById({
			env: { ...failingEnv.env, APP_DB: readyDb },
			dbUserId,
			stableUserId,
			messageId: 'msg-1',
			now: nowIso,
		}),
	).rejects.toThrow(/mailbox unavailable/)
	expect(failingGet).toHaveBeenCalled()
	expect(getEmailMessageByIdMock).not.toHaveBeenCalled()
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
