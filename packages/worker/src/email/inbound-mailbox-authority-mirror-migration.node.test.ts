import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const authorityMirrorMigration =
	'0129-email-inbound-mailbox-authority-mirror.sql'

function applyMigrationsBefore(db: DatabaseSync, exclusiveUpperBound: string) {
	for (const fileName of readdirSync(migrationsDirectory)
		.filter((file) => file.endsWith('.sql') && file < exclusiveUpperBound)
		.sort()) {
		db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
	}
}

function applyMigrationLikeD1(db: DatabaseSync, fileName: string) {
	const sql = readFileSync(new URL(fileName, migrationsDirectory), 'utf8')
	db.exec('BEGIN')
	try {
		db.exec(sql)
		db.exec('COMMIT')
	} catch (error) {
		db.exec('ROLLBACK')
		throw error
	}
}

test('0129 promotes legacy inbound authority and cascades usage idempotency', () => {
	using db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, authorityMirrorMigration)
	expect(
		db
			.prepare(`PRAGMA table_info(email_delivery_events)`)
			.all()
			.some((column) => column.name === 'state'),
	).toBe(false)

	const createdAt = '2026-08-01T00:00:00.000Z'
	const insert = db.prepare(
		`INSERT INTO email_delivery_events (
			id, user_id, event_type, provider, detail_json,
			needs_effect_reconcile, usage_effect_recorded_at, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	)
	insert.run(
		'delivery-backfill',
		'user-backfill',
		'received',
		'cloudflare-email-routing',
		JSON.stringify({
			state: 'received',
			fingerprint: 'fingerprint-backfill',
			storageLease: 'storage-lease',
			storageLeaseAt: '2026-08-01T00:01:00.000Z',
			cleanupLease: 'cleanup-lease',
			cleanupLeaseAt: '2026-08-01T00:02:00.000Z',
			cleanupRetryAt: '2026-08-01T00:03:00.000Z',
			expectedAttachmentCount: 2,
			finalizationToken: 'finalization-token',
			reconcileAfter: '2026-08-01T00:04:00.000Z',
			dedupeExpiresAt: '2026-08-02T00:00:00.000Z',
			usageEffectSuppressedAt: '2026-08-01T00:05:00.000Z',
			usageStartedAt: '2026-08-01T00:06:00.000Z',
			usageEffectRetryAt: '2026-08-01T00:07:00.000Z',
			usageEffectLease: 'usage-lease',
			usageEffectLeaseAt: '2026-08-01T00:08:00.000Z',
			subscriptionEffectState: 'processing',
			subscriptionEffectLease: 'subscription-lease',
			subscriptionEffectLeaseAt: '2026-08-01T00:09:00.000Z',
			subscriptionEffectRetryAt: '2026-08-01T00:10:00.000Z',
			subscriptionEffectAttemptCount: 3,
			subscriptionEffectDeadLetterAt: '2026-08-01T00:11:00.000Z',
			subscriptionEffectLastError: 'dispatch failed',
		}),
		0,
		null,
		createdAt,
	)
	insert.run(
		'usage-null-lease-at',
		'user-usage-due',
		'received',
		'cloudflare-email-routing',
		JSON.stringify({
			state: 'received',
			fingerprint: 'fingerprint-usage',
			usageEffectLease: 'legacy-usage-lease',
			subscriptionEffectState: 'complete',
		}),
		1,
		null,
		createdAt,
	)
	insert.run(
		'subscription-null-lease-at',
		'user-subscription-due',
		'received',
		'cloudflare-email-routing',
		JSON.stringify({
			state: 'received',
			fingerprint: 'fingerprint-subscription',
			subscriptionEffectState: 'processing',
			subscriptionEffectLease: 'legacy-subscription-lease',
		}),
		1,
		'2026-08-01T00:01:00.000Z',
		createdAt,
	)
	insert.run(
		'email-inbound-dedupe:fingerprint-dedupe',
		'user-dedupe',
		'receive_started',
		'cloudflare-email-routing-dedupe',
		JSON.stringify({
			state: 'pending',
			fingerprint: 'fingerprint-dedupe',
			dedupeExpiresAt: '2026-08-01T01:00:00.000Z',
		}),
		0,
		null,
		createdAt,
	)
	insert.run(
		'delivery-system',
		'system:email',
		'received',
		'kody-system-email',
		JSON.stringify({
			state: 'received',
			fingerprint: 'system-fingerprint',
		}),
		0,
		null,
		createdAt,
	)

	db.exec('PRAGMA foreign_keys = ON')
	applyMigrationLikeD1(db, authorityMirrorMigration)

	expect(
		db
			.prepare(
				`SELECT
					state, fingerprint, storage_lease, storage_lease_at,
					cleanup_lease, cleanup_lease_at, cleanup_retry_at,
					expected_attachment_count, finalization_token, reconcile_after,
					dedupe_expires_at, usage_effect_suppressed_at, usage_started_at,
					usage_effect_retry_at, usage_effect_lease, usage_effect_lease_at,
					subscription_effect_state, subscription_effect_lease,
					subscription_effect_lease_at, subscription_effect_retry_at,
					subscription_effect_attempt_count,
					subscription_effect_dead_letter_at,
					subscription_effect_last_error, updated_at
				FROM email_delivery_events
				WHERE id = 'delivery-backfill'`,
			)
			.get(),
	).toEqual({
		state: 'received',
		fingerprint: 'fingerprint-backfill',
		storage_lease: 'storage-lease',
		storage_lease_at: '2026-08-01T00:01:00.000Z',
		cleanup_lease: 'cleanup-lease',
		cleanup_lease_at: '2026-08-01T00:02:00.000Z',
		cleanup_retry_at: '2026-08-01T00:03:00.000Z',
		expected_attachment_count: 2,
		finalization_token: 'finalization-token',
		reconcile_after: '2026-08-01T00:04:00.000Z',
		dedupe_expires_at: '2026-08-02T00:00:00.000Z',
		usage_effect_suppressed_at: '2026-08-01T00:05:00.000Z',
		usage_started_at: '2026-08-01T00:06:00.000Z',
		usage_effect_retry_at: '2026-08-01T00:07:00.000Z',
		usage_effect_lease: 'usage-lease',
		usage_effect_lease_at: '2026-08-01T00:08:00.000Z',
		subscription_effect_state: 'processing',
		subscription_effect_lease: 'subscription-lease',
		subscription_effect_lease_at: '2026-08-01T00:09:00.000Z',
		subscription_effect_retry_at: '2026-08-01T00:10:00.000Z',
		subscription_effect_attempt_count: 3,
		subscription_effect_dead_letter_at: '2026-08-01T00:11:00.000Z',
		subscription_effect_last_error: 'dispatch failed',
		updated_at: createdAt,
	})
	expect(
		db
			.prepare(
				`SELECT state, fingerprint, updated_at
				FROM email_delivery_events
				WHERE id = 'delivery-system'`,
			)
			.get(),
	).toEqual({
		state: null,
		fingerprint: null,
		updated_at: createdAt,
	})
	expect(
		db
			.prepare(
				`SELECT state, fingerprint, dedupe_expires_at, updated_at
				FROM email_delivery_events
				WHERE id = 'email-inbound-dedupe:fingerprint-dedupe'`,
			)
			.get(),
	).toEqual({
		state: 'pending',
		fingerprint: 'fingerprint-dedupe',
		dedupe_expires_at: '2026-08-01T01:00:00.000Z',
		updated_at: createdAt,
	})

	expect(
		db
			.prepare(
				`SELECT name FROM sqlite_schema
				WHERE type = 'index'
					AND name IN (
						'idx_email_delivery_events_user_state_created',
						'idx_email_delivery_events_user_dedupe_expires'
					)
				ORDER BY name`,
			)
			.all(),
	).toEqual([
		{ name: 'idx_email_delivery_events_user_dedupe_expires' },
		{ name: 'idx_email_delivery_events_user_state_created' },
	])
	expect(
		db
			.prepare(
				`SELECT id
				FROM email_delivery_events
				WHERE provider = 'cloudflare-email-routing'
					AND event_type = 'received'
					AND needs_effect_reconcile = 1
					AND fingerprint IS NOT NULL
					AND (
						(
							usage_effect_recorded_at IS NULL
							AND usage_effect_suppressed_at IS NULL
							AND (
								usage_effect_lease IS NULL
								OR usage_effect_lease_at IS NULL
								OR usage_effect_lease_at < ?
							)
						)
						OR (
							usage_effect_recorded_at IS NOT NULL
							AND subscription_effect_state = 'processing'
							AND (
								subscription_effect_lease_at IS NULL
								OR subscription_effect_lease_at < ?
							)
						)
					)
				ORDER BY id`,
			)
			.all('2026-08-01T00:30:00.000Z', '2026-08-01T00:30:00.000Z'),
	).toEqual([
		{ id: 'subscription-null-lease-at' },
		{ id: 'usage-null-lease-at' },
	])
})
