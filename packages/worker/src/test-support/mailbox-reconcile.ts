import { DatabaseSync } from 'node:sqlite'
import { vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import type * as MailboxClientModule from '#worker/email/mailbox-client.ts'
import type * as MailboxLiveMirrorModule from '#worker/email/mailbox-live-mirror.ts'
import type * as MailboxMirrorModule from '#worker/email/mailbox-mirror.ts'
import type * as MailboxParityEventsModule from '#worker/email/mailbox-parity-events.ts'
import { ensureEmailTestSchema } from '#worker/email/test-schema.ts'

const mocks = vi.hoisted(() => ({
	mirrorMailboxMessageGraphFromD1: vi.fn(),
	mirrorMailboxDeliveryEventFromD1: vi.fn(),
	mirrorMailboxDeliveryEventSnapshots: vi.fn(),
	awaitMailboxMirrorRpc: vi.fn(),
	recordMailboxParityEvent: vi.fn(),
	mailboxRpc: vi.fn(),
}))

vi.mock('#worker/email/mailbox-live-mirror.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof MailboxLiveMirrorModule>()
	return {
		...actual,
		mirrorMailboxMessageGraphFromD1: mocks.mirrorMailboxMessageGraphFromD1,
		mirrorMailboxDeliveryEventFromD1: mocks.mirrorMailboxDeliveryEventFromD1,
	}
})

vi.mock('#worker/email/mailbox-mirror.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof MailboxMirrorModule>()
	return {
		...actual,
		awaitMailboxMirrorRpc: mocks.awaitMailboxMirrorRpc,
		mirrorMailboxDeliveryEventSnapshots:
			mocks.mirrorMailboxDeliveryEventSnapshots,
	}
})

vi.mock('#worker/email/mailbox-parity-events.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof MailboxParityEventsModule>()
	return {
		...actual,
		recordMailboxParityEvent: mocks.recordMailboxParityEvent,
	}
})

vi.mock('#worker/email/mailbox-client.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof MailboxClientModule>()
	return {
		...actual,
		mailboxRpc: mocks.mailboxRpc,
	}
})

export type MailboxReconcileTestMocks = typeof mocks

export function getMailboxReconcileTestMocks(): MailboxReconcileTestMocks {
	return mocks
}

export const {
	countD1MailboxParity,
	listEventBackfillPage,
	listUsersForMailboxParity,
	reconcileMailboxParity,
} = await import('#worker/email/mailbox-reconcile.ts')

export async function createParityDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureUsersTestSchema({ db })
	await ensureEmailTestSchema(db)
	return { sqlite, db }
}

export async function insertUser(input: {
	db: D1Database
	userId: string
	email?: string
	deletingAt?: string | null
	checkedAt?: string | null
}) {
	await input.db
		.prepare(
			`INSERT INTO users (
				username, email, password_hash, stable_user_id, deleting_at,
				mailbox_parity_checked_at
			) VALUES (?, ?, 'hash', ?, ?, ?)`,
		)
		.bind(
			`u-${crypto.randomUUID().slice(0, 8)}`,
			input.email ?? `${crypto.randomUUID()}@example.test`,
			input.userId,
			input.deletingAt ?? null,
			input.checkedAt ?? null,
		)
		.run()
}

export async function insertMessage(input: {
	db: D1Database
	userId: string
	id: string
	createdAt: string
	updatedAt?: string
}) {
	await input.db
		.prepare(
			`INSERT INTO email_messages (
				id, direction, user_id, from_address, subject, text_body, raw_size,
				processing_status, created_at, updated_at
			) VALUES (?, 'inbound', ?, 'from@example.test', 'hi', 'body', 4,
				'stored', ?, ?)`,
		)
		.bind(
			input.id,
			input.userId,
			input.createdAt,
			input.updatedAt ?? input.createdAt,
		)
		.run()
}

export async function insertEvent(input: {
	db: D1Database
	userId: string
	id: string
	createdAt: string
	messageId?: string | null
}) {
	await input.db
		.prepare(
			`INSERT INTO email_delivery_events (
				id, message_id, user_id, event_type, provider, detail_json, created_at
			) VALUES (?, ?, ?, 'receive_started', 'cloudflare-email-routing', '{}', ?)`,
		)
		.bind(
			input.id,
			input.messageId === undefined ? null : input.messageId,
			input.userId,
			input.createdAt,
		)
		.run()
}

export async function parkUser(db: D1Database, userId: string) {
	await db
		.prepare(
			`UPDATE users
			SET mailbox_parity_checked_at = '9999-01-01T00:00:00.000Z'
			WHERE stable_user_id = ?`,
		)
		.bind(userId)
		.run()
}

export async function readParityRow(db: D1Database, userId: string) {
	return db
		.prepare(
			`SELECT
				mailbox_parity_checked_at AS checkedAt,
				mailbox_parity_matching_since AS matchingSince,
				mailbox_parity_mismatch_count AS mismatchCount,
				mailbox_parity_last_error AS lastError,
				mailbox_parity_content_watermark_at AS contentWatermarkAt,
				mailbox_parity_content_replay_upper_at AS contentReplayUpperAt,
				mailbox_parity_content_replay_cursor_updated_at AS contentReplayCursorUpdatedAt,
				mailbox_parity_content_replay_cursor_id AS contentReplayCursorId,
				mailbox_parity_message_backfill_cursor_created_at AS messageCursorCreatedAt,
				mailbox_parity_message_backfill_cursor_id AS messageCursorId,
				mailbox_parity_message_backfill_completed_at AS messagesCompletedAt,
				mailbox_parity_event_backfill_cursor_created_at AS eventCursorCreatedAt,
				mailbox_parity_event_backfill_cursor_id AS eventCursorId,
				mailbox_parity_event_backfill_completed_at AS eventsCompletedAt
			FROM users
			WHERE stable_user_id = ?`,
		)
		.bind(userId)
		.first<{
			checkedAt: string | null
			matchingSince: string | null
			mismatchCount: number
			lastError: string | null
			contentWatermarkAt: string | null
			contentReplayUpperAt: string | null
			contentReplayCursorUpdatedAt: string | null
			contentReplayCursorId: string | null
			messageCursorCreatedAt: string | null
			messageCursorId: string | null
			messagesCompletedAt: string | null
			eventCursorCreatedAt: string | null
			eventCursorId: string | null
			eventsCompletedAt: string | null
		}>()
}

export function successGraph(messageId: string, eventsTruncated = false) {
	return {
		messageId,
		message: { status: 'mirrored' as const },
		events: [],
		eventsTruncated,
	}
}

/** Default event-backfill batch mock: every snapshot mirrors. */
export function mockMirroredEventSnapshots() {
	mocks.mirrorMailboxDeliveryEventSnapshots.mockImplementation(
		async (input: { events: Array<{ id: string }> }) =>
			input.events.map((event) => ({
				eventId: event.id,
				result: { status: 'mirrored' as const },
			})),
	)
}

export function mockDoCounts(
	counts: {
		threads: number
		messages: number
		attachments: number
		deliveryEvents: number
	},
	options?: { purge?: () => Promise<{ ok: true }> },
) {
	const purge = options?.purge ?? vi.fn(async () => ({ ok: true as const }))
	mocks.mailboxRpc.mockImplementation(() => ({
		countMailbox: vi.fn(async () => counts),
		purge,
	}))
	mocks.awaitMailboxMirrorRpc.mockImplementation(
		async (promise: Promise<unknown>) => ({
			ok: true as const,
			value: await promise,
		}),
	)
	return { purge }
}

export function parityEnv(db: D1Database) {
	return {
		APP_DB: db,
		MAILBOX: {} as DurableObjectNamespace,
		EMAIL_EVENTS: {
			writeDataPoint: vi.fn(),
		} as unknown as AnalyticsEngineDataset,
	}
}
