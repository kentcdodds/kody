import { expect, test, vi } from 'vitest'
import {
	assertUserEmailD1StatementAllowed,
	liveUserEmailD1Database,
	prepareUserEmailD1Statement,
} from './user-email-d1-guard.ts'

test.each([
	'SELECT * FROM email_threads',
	'UPDATE email_messages SET updated_at = ?',
	'DELETE FROM email_attachments WHERE message_id = ?',
	'INSERT INTO email_delivery_events (id) VALUES (?)',
	'SELECT * FROM "email_messages"',
	'SELECT * FROM `email_attachments`',
	'SELECT * FROM [email_delivery_events]',
	"SELECT * FROM 'email_threads'",
	'SELECT * FROM main."email_messages"',
	"DELETE FROM 'main'.'email_attachments' WHERE message_id = ?",
	'UPDATE [main].[email_delivery_events] SET updated_at = ?',
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

test.each(['system-legacy-rollback', 'drop-tooling'] as const)(
	'allows explicit non-live marker %s',
	(marker) => {
		expect(() =>
			assertUserEmailD1StatementAllowed({
				sql: 'SELECT * FROM email_messages',
				marker,
			}),
		).not.toThrow()
	},
)

test('privacy cleanup allows only reads and deletes', () => {
	expect(() =>
		assertUserEmailD1StatementAllowed({
			sql: 'SELECT id FROM email_messages',
			marker: 'frozen-privacy-cleanup',
		}),
	).not.toThrow()
	expect(() =>
		assertUserEmailD1StatementAllowed({
			sql: 'DELETE FROM email_messages WHERE id = ?',
			marker: 'frozen-privacy-cleanup',
		}),
	).not.toThrow()
	expect(() =>
		assertUserEmailD1StatementAllowed({
			sql: 'UPDATE email_messages SET updated_at = ?',
			marker: 'frozen-privacy-cleanup',
		}),
	).toThrow(/permits only SELECT\/DELETE/)
})

test('frozen backup audit is read-only', () => {
	expect(() =>
		assertUserEmailD1StatementAllowed({
			sql: 'SELECT COUNT(*) FROM email_messages',
			marker: 'frozen-backup-audit',
		}),
	).not.toThrow()
	expect(() =>
		assertUserEmailD1StatementAllowed({
			sql: 'DELETE FROM email_messages',
			marker: 'frozen-backup-audit',
		}),
	).toThrow(/read-only/)
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
