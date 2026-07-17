import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationUrl = new URL(
	'../../migrations/0061-email-delivery-lifecycle.sql',
	import.meta.url,
)

test('email delivery migration deduplicates and uniquely indexes provider message ids', () => {
	const db = new DatabaseSync(':memory:')
	db.exec(`
		CREATE TABLE email_inboxes (
			id TEXT PRIMARY KEY
		);
		CREATE TABLE email_messages (
			id TEXT PRIMARY KEY,
			direction TEXT NOT NULL,
			provider_message_id TEXT,
			created_at TEXT NOT NULL
		);
		CREATE TABLE email_delivery_events (
			id TEXT PRIMARY KEY,
			message_id TEXT,
			user_id TEXT,
			inbox_id TEXT,
			event_type TEXT NOT NULL,
			provider TEXT NOT NULL DEFAULT 'kody',
			provider_message_id TEXT,
			detail_json TEXT NOT NULL DEFAULT '{}',
			created_at TEXT NOT NULL
		);
		INSERT INTO email_messages (
			id, direction, provider_message_id, created_at
		) VALUES
			('message-first', 'outbound', 'provider-1', '2026-07-17T20:00:00.000Z'),
			('message-duplicate', 'outbound', 'provider-1', '2026-07-17T20:01:00.000Z');
	`)

	db.exec(readFileSync(migrationUrl, 'utf8'))

	expect(
		db
			.prepare(
				`SELECT id, provider_message_id
				FROM email_messages
				ORDER BY created_at ASC`,
			)
			.all(),
	).toEqual([
		{ id: 'message-first', provider_message_id: 'provider-1' },
		{ id: 'message-duplicate', provider_message_id: null },
	])
	expect(() => {
		db.prepare(
			`UPDATE email_messages
			 SET provider_message_id = 'provider-1'
			 WHERE id = 'message-duplicate'`,
		).run()
	}).toThrow(/UNIQUE constraint failed/)
})
