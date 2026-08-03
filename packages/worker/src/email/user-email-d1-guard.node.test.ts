import { expect, test, vi } from 'vitest'
import {
	assertUserEmailD1StatementAllowed,
	liveUserEmailD1Database,
	prepareUserEmailD1Statement,
} from './user-email-d1-guard.ts'
import { getEmailDeliveryEventMirrorProjection } from './mailbox-snapshot-repo.ts'
import { getEmailMessageById } from './repo.ts'

test.each([
	'SELECT * FROM email_threads',
	'UPDATE email_messages SET updated_at = ?',
	'DELETE FROM email_attachments WHERE message_id = ?',
	'INSERT INTO email_delivery_events (id) VALUES (?)',
	'SELECT * FROM "email_messages"',
	'SELECT * FROM `email_attachments`',
	'SELECT * FROM [email_delivery_events]',
])('rejects live graph SQL before preparing it: %s', (sql) => {
	const prepare = vi.fn()
	expect(() =>
		prepareUserEmailD1Statement({
			db: { prepare } as unknown as D1Database,
			sql,
			marker: 'live-user',
		}),
	).toThrow(/Live USER D1 access/)
	expect(prepare).not.toHaveBeenCalled()
})

test('tokenization ignores table names in comments and string values', () => {
	expect(() =>
		assertUserEmailD1StatementAllowed({
			sql: `SELECT 'email_messages' AS label /* email_threads */ FROM users`,
			marker: 'live-user',
		}),
	).not.toThrow()
})

test.each([
	'system-legacy-rollback',
	'frozen-rollback-audit',
	'drop-tooling',
] as const)('allows explicit non-live marker %s', (marker) => {
	expect(() =>
		assertUserEmailD1StatementAllowed({
			sql: 'SELECT * FROM email_messages',
			marker,
		}),
	).not.toThrow()
})

test('legacy repo boundary rejects a USER graph read before D1 prepare', async () => {
	const prepare = vi.fn()
	await expect(
		getEmailMessageById({
			db: { prepare } as unknown as D1Database,
			userId: 'user-1',
			messageId: 'message-1',
		}),
	).rejects.toThrow(/Legacy USER D1 email graph operation is disabled/)
	expect(prepare).not.toHaveBeenCalled()
})

test('frozen rollback loader requires an explicit non-live marker', async () => {
	const prepare = vi.fn()
	await expect(
		getEmailDeliveryEventMirrorProjection({
			db: { prepare } as unknown as D1Database,
			marker: 'live-user',
			ownerId: 'user-1',
			eventId: 'event-1',
		}),
	).rejects.toThrow(/Live USER D1 access/)
	expect(prepare).not.toHaveBeenCalled()
})

test('live database boundary rejects prepare and exec before D1', async () => {
	const prepare = vi.fn()
	const exec = vi.fn()
	const db = liveUserEmailD1Database({
		prepare,
		exec,
	} as unknown as D1Database)

	expect(() => db.prepare('SELECT * FROM email_messages')).toThrow(
		/Live USER D1 access/,
	)
	expect(() => db.exec('DELETE FROM email_delivery_events')).toThrow(
		/Live USER D1 access/,
	)
	expect(prepare).not.toHaveBeenCalled()
	expect(exec).not.toHaveBeenCalled()
})
