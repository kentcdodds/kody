import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { emailOutboundProviderCloudflare } from './outbound-provider-index.ts'

const migrationUrl = new URL(
	'../../migrations/0128-email-outbound-provider-index.sql',
	import.meta.url,
)

function createPreMigrationDb() {
	const db = new DatabaseSync(':memory:')
	db.exec('PRAGMA foreign_keys = ON')
	db.exec(`
		CREATE TABLE email_messages (
			id TEXT PRIMARY KEY,
			direction TEXT NOT NULL,
			user_id TEXT NOT NULL,
			inbox_id TEXT,
			provider_message_id TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE UNIQUE INDEX idx_email_messages_provider_message_id
		ON email_messages(provider_message_id)
		WHERE direction = 'outbound' AND provider_message_id IS NOT NULL;
	`)
	return db
}

test('provider index migration backfills outbound provider ids including system owner', () => {
	const db = createPreMigrationDb()
	db.exec(`
		INSERT INTO email_messages (
			id, direction, user_id, inbox_id, provider_message_id, created_at, updated_at
		) VALUES
			('user-msg', 'outbound', 'user-1', 'inbox-1', 'prov-user',
				'2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
			('system-msg', 'outbound', 'system:email', NULL, 'prov-system',
				'2026-08-01T00:01:00.000Z', '2026-08-01T00:01:00.000Z'),
			('inbound-msg', 'inbound', 'user-1', 'inbox-1', 'prov-inbound',
				'2026-08-01T00:02:00.000Z', '2026-08-01T00:02:00.000Z'),
			('no-provider', 'outbound', 'user-1', NULL, NULL,
				'2026-08-01T00:03:00.000Z', '2026-08-01T00:03:00.000Z');
	`)

	db.exec(readFileSync(migrationUrl, 'utf8'))

	expect(
		db
			.prepare(
				`SELECT provider, provider_message_id, user_id, message_id, inbox_id
				FROM email_outbound_provider_index
				ORDER BY provider_message_id ASC`,
			)
			.all(),
	).toEqual([
		{
			provider: emailOutboundProviderCloudflare,
			provider_message_id: 'prov-system',
			user_id: 'system:email',
			message_id: 'system-msg',
			inbox_id: null,
		},
		{
			provider: emailOutboundProviderCloudflare,
			provider_message_id: 'prov-user',
			user_id: 'user-1',
			message_id: 'user-msg',
			inbox_id: 'inbox-1',
		},
	])

	expect(() => {
		db.prepare(
			`INSERT INTO email_outbound_provider_index (
				provider, provider_message_id, user_id, message_id, inbox_id,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, NULL, ?, ?)`,
		).run(
			emailOutboundProviderCloudflare,
			'prov-user',
			'other-user',
			'other-msg',
			'2026-08-01T00:04:00.000Z',
			'2026-08-01T00:04:00.000Z',
		)
	}).toThrow(/UNIQUE constraint failed|FOREIGN KEY/u)

	expect(() => {
		db.prepare(
			`INSERT INTO email_outbound_provider_index (
				provider, provider_message_id, user_id, message_id, inbox_id,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, NULL, ?, ?)`,
		).run(
			emailOutboundProviderCloudflare,
			'prov-other',
			'user-1',
			'user-msg',
			'2026-08-01T00:04:00.000Z',
			'2026-08-01T00:04:00.000Z',
		)
	}).toThrow(/UNIQUE constraint failed/)

	db.prepare(`DELETE FROM email_messages WHERE id = 'user-msg'`).run()
	expect(
		db
			.prepare(
				`SELECT provider_message_id
				FROM email_outbound_provider_index
				ORDER BY provider_message_id`,
			)
			.all(),
	).toEqual([{ provider_message_id: 'prov-system' }])
})
