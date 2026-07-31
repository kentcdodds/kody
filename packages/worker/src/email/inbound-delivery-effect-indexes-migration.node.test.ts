import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migration = readFileSync(
	new URL(
		'../../migrations/0123-inbound-delivery-effect-indexes.sql',
		import.meta.url,
	),
	'utf8',
)

const effectDuePredicate = `
	provider = 'cloudflare-email-routing'
	AND event_type = 'received'
	AND json_extract(detail_json, '$.fingerprint') IS NOT NULL
	AND (
		(
			json_extract(detail_json, '$.usageEffectRecordedAt') IS NULL
			AND json_extract(detail_json, '$.usageEffectSuppressedAt') IS NULL
			AND (
				json_extract(detail_json, '$.usageEffectRetryAt') IS NULL
				OR json_extract(detail_json, '$.usageEffectRetryAt') <= ?
			)
			AND (
				json_extract(detail_json, '$.usageEffectLease') IS NULL
				OR json_extract(detail_json, '$.usageEffectLeaseAt') < ?
			)
		)
		OR (
			(
				json_extract(detail_json, '$.subscriptionEffectState') IS NULL
				OR json_extract(
					detail_json,
					'$.subscriptionEffectState'
				) NOT IN ('complete', 'dead-letter')
			)
			AND (
				json_extract(detail_json, '$.subscriptionEffectRetryAt') IS NULL
				OR json_extract(detail_json, '$.subscriptionEffectRetryAt') <= ?
			)
			AND (
				json_extract(detail_json, '$.subscriptionEffectState') != 'processing'
				OR json_extract(detail_json, '$.subscriptionEffectLeaseAt') < ?
			)
		)
	)
`

test('indexed inbound effect path preserves the legacy due set', () => {
	const db = new DatabaseSync(':memory:')
	db.exec(`
		CREATE TABLE email_messages (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			raw_size INTEGER NOT NULL DEFAULT 0,
			received_at TEXT,
			created_at TEXT NOT NULL
		);
		CREATE TABLE email_delivery_events (
			id TEXT PRIMARY KEY,
			message_id TEXT,
			user_id TEXT,
			provider TEXT NOT NULL,
			event_type TEXT NOT NULL,
			detail_json TEXT NOT NULL DEFAULT '{}',
			created_at TEXT NOT NULL
		);
	`)
	const insert = db.prepare(`
		INSERT INTO email_delivery_events (
			id, message_id, user_id, provider, event_type, detail_json, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?)
	`)
	const createdAt = '2026-07-30T00:00:00.000Z'
	const rows = [
		{
			id: 'usage-due',
			detail: { fingerprint: 'a', subscriptionEffectState: 'complete' },
		},
		{
			id: 'usage-retry-future',
			detail: {
				fingerprint: 'b',
				usageEffectRetryAt: '2026-08-01T01:00:00.000Z',
				subscriptionEffectState: 'complete',
			},
		},
		{
			id: 'subscription-due',
			detail: {
				fingerprint: 'c',
				usageEffectRecordedAt: '2026-07-31T00:00:00.000Z',
				usageMonth: '2026-07',
				usageBytes: 30,
				subscriptionEffectState: 'pending',
			},
		},
		{
			id: 'subscription-lease-fresh',
			detail: {
				fingerprint: 'd',
				usageEffectRecordedAt: '2026-07-31T00:00:00.000Z',
				usageMonth: '2026-07',
				usageBytes: 40,
				subscriptionEffectState: 'processing',
				subscriptionEffectLeaseAt: '2026-07-31T00:59:00.000Z',
			},
		},
		{
			id: 'complete',
			detail: {
				fingerprint: 'e',
				usageEffectRecordedAt: '2026-07-31T00:00:00.000Z',
				usageMonth: '2026-07',
				usageBytes: 50,
				subscriptionEffectState: 'complete',
			},
		},
		{
			id: 'dead-letter',
			detail: {
				fingerprint: 'f',
				usageEffectRecordedAt: '2026-07-31T00:00:00.000Z',
				usageMonth: '2026-07',
				usageBytes: 60,
				subscriptionEffectState: 'dead-letter',
			},
		},
		{
			id: 'unrelated-received',
			provider: 'test',
			detail: { fingerprint: 'g' },
		},
		{
			id: 'missing-fingerprint',
			detail: { subscriptionEffectState: 'pending' },
		},
	]
	for (const row of rows) {
		insert.run(
			row.id,
			null,
			`user-${row.id}`,
			row.provider ?? 'cloudflare-email-routing',
			'received',
			JSON.stringify(row.detail),
			createdAt,
		)
	}
	const dueParameters = [
		'2026-07-31T01:00:00.000Z',
		'2026-07-31T00:55:00.000Z',
		'2026-07-31T01:00:00.000Z',
		'2026-07-31T00:55:00.000Z',
	] as const
	const legacyDue = db
		.prepare(
			`SELECT id FROM email_delivery_events
			WHERE ${effectDuePredicate}
			ORDER BY id`,
		)
		.all(...dueParameters)

	db.exec(`BEGIN; ${migration} COMMIT;`)

	const indexedDue = db
		.prepare(
			`SELECT id FROM email_delivery_events
			WHERE needs_effect_reconcile = 1
				AND ${effectDuePredicate}
			ORDER BY id`,
		)
		.all(...dueParameters)
	expect(indexedDue).toEqual(legacyDue)
	expect(indexedDue).toEqual([{ id: 'subscription-due' }, { id: 'usage-due' }])

	const plans = db
		.prepare(
			`EXPLAIN QUERY PLAN
			SELECT id FROM email_delivery_events
			WHERE needs_effect_reconcile = 1
				AND ${effectDuePredicate}`,
		)
		.all(...dueParameters) as Array<{ detail: string }>
	expect(plans.map((row) => row.detail).join('\n')).toContain(
		'idx_email_delivery_events_pending_effects',
	)
})

test('migration preserves durable inbound usage while indexing month reads', () => {
	const db = new DatabaseSync(':memory:')
	db.exec(`
		CREATE TABLE email_messages (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			raw_size INTEGER NOT NULL DEFAULT 0,
			received_at TEXT,
			created_at TEXT NOT NULL
		);
		CREATE TABLE email_delivery_events (
			id TEXT PRIMARY KEY,
			message_id TEXT,
			user_id TEXT,
			provider TEXT NOT NULL,
			event_type TEXT NOT NULL,
			detail_json TEXT NOT NULL DEFAULT '{}',
			created_at TEXT NOT NULL
		);
		INSERT INTO email_messages (
			id, user_id, raw_size, received_at, created_at
		) VALUES (
			'message-1', 'user-1', 321,
			'2026-07-31T23:59:59.000Z', '2026-07-31T23:59:59.000Z'
		);
		INSERT INTO email_delivery_events (
			id, message_id, user_id, provider, event_type, detail_json, created_at
		) VALUES (
			'event-1', 'message-1', 'user-1',
			'cloudflare-email-routing', 'received',
			'{"fingerprint":"a","usageEffectRecordedAt":"2026-08-01T00:00:00.000Z","usageDurationMs":45,"subscriptionEffectState":"complete"}',
			'2026-07-31T23:59:59.000Z'
		), (
			'event-unhydratable', NULL, 'user-2',
			'cloudflare-email-routing', 'received',
			'{"fingerprint":"b","usageEffectRecordedAt":"2026-08-01T00:00:00.000Z","subscriptionEffectState":"complete"}',
			'2026-07-31T23:59:59.000Z'
		);
	`)
	const legacy = db
		.prepare(
			`SELECT
				user_id,
				json_extract(detail_json, '$.usageEffectRecordedAt') AS recorded_at,
				COALESCE(
					json_extract(detail_json, '$.usageMonth'),
					(
						SELECT substr(COALESCE(message.received_at, message.created_at), 1, 7)
						FROM email_messages message
						WHERE message.id = email_delivery_events.message_id
							AND message.user_id = email_delivery_events.user_id
					)
				) AS month,
				COALESCE(json_extract(detail_json, '$.usageBytes'), 321) AS bytes,
				COALESCE(json_extract(detail_json, '$.usageDurationMs'), 0) AS duration_ms
			FROM email_delivery_events
			WHERE provider = 'cloudflare-email-routing'
				AND event_type = 'received'
				AND json_extract(detail_json, '$.usageEffectRecordedAt') IS NOT NULL
				AND COALESCE(
					json_extract(detail_json, '$.usageMonth'),
					(
						SELECT substr(COALESCE(message.received_at, message.created_at), 1, 7)
						FROM email_messages message
						WHERE message.id = email_delivery_events.message_id
							AND message.user_id = email_delivery_events.user_id
					)
				) IN ('2026-07', '2026-06')`,
		)
		.all()

	db.exec(`BEGIN; ${migration} COMMIT;`)

	const indexed = db
		.prepare(
			`SELECT
				user_id,
				usage_effect_recorded_at AS recorded_at,
				usage_month AS month,
				usage_bytes AS bytes,
				usage_duration_ms AS duration_ms
			FROM email_delivery_events
			WHERE provider = 'cloudflare-email-routing'
				AND event_type = 'received'
				AND usage_effect_recorded_at IS NOT NULL
				AND usage_month IN ('2026-07', '2026-06')`,
		)
		.all()
	expect(indexed).toEqual(legacy)
	expect(
		db
			.prepare(
				`SELECT needs_effect_reconcile
				FROM email_delivery_events
				WHERE id = 'event-unhydratable'`,
			)
			.get(),
	).toEqual({ needs_effect_reconcile: 0 })

	const plans = db
		.prepare(
			`EXPLAIN QUERY PLAN
			SELECT user_id FROM email_delivery_events
			WHERE provider = 'cloudflare-email-routing'
				AND event_type = 'received'
				AND usage_effect_recorded_at IS NOT NULL
				AND usage_month IN ('2026-07', '2026-06')`,
		)
		.all() as Array<{ detail: string }>
	expect(plans.map((row) => row.detail).join('\n')).toContain(
		'idx_email_delivery_events_recorded_usage_month',
	)
})
