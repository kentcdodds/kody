import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migration = readFileSync(
	new URL(
		'../../migrations/0089-email-delivery-reconciliation-index.sql',
		import.meta.url,
	),
	'utf8',
)

test('inbound reconciliation migration indexes global provider event scans', () => {
	const db = new DatabaseSync(':memory:')
	db.exec(`
		CREATE TABLE email_delivery_events (
			id TEXT PRIMARY KEY,
			user_id TEXT,
			provider TEXT NOT NULL,
			event_type TEXT NOT NULL,
			detail_json TEXT NOT NULL DEFAULT '{}',
			created_at TEXT NOT NULL
		);
		BEGIN;
		${migration}
		COMMIT;
	`)

	expect(
		db
			.prepare(
				`SELECT sql FROM sqlite_master
				WHERE type = 'index'
					AND name = 'idx_email_delivery_events_provider_event_created_at'`,
			)
			.get(),
	).toEqual({
		sql: 'CREATE INDEX idx_email_delivery_events_provider_event_created_at\nON email_delivery_events(provider, event_type, created_at)',
	})

	const plans = db
		.prepare(
			`EXPLAIN QUERY PLAN
			SELECT user_id FROM email_delivery_events
			WHERE provider = 'cloudflare-email-routing'
				AND event_type = 'receive_started'
				AND created_at < ?`,
		)
		.all('2026-07-23T00:00:00.000Z') as Array<{ detail: string }>
	expect(plans.map((row) => row.detail).join('\n')).toContain(
		'idx_email_delivery_events_provider_event_created_at',
	)
})
