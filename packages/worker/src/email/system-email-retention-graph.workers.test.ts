import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import {
	loadSystemEmailGraphParityReport,
	reconcileLegacySystemEmailGraphFromDedicated,
} from './system-email-graph-repo.ts'
import {
	pruneSystemEmailRetention,
	systemEmailLimits,
	systemEmailOwnerId,
} from './system-email.ts'
import { emailRawMimeKey } from './blob-keys.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

test('orphan-thread retention respects its deadline and one bounded batch', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await env.APP_DB.prepare(
		`WITH RECURSIVE sequence(value) AS (
			VALUES(0) UNION ALL SELECT value + 1 FROM sequence WHERE value < 59
		)
		INSERT INTO system_email_threads (
			id, subject_normalized, last_message_at, created_at, updated_at
		)
		SELECT printf('bounded-orphan-%02d', value), 'orphan',
			CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
		FROM sequence`,
	).run()
	await reconcileLegacySystemEmailGraphFromDedicated({
		db: env.APP_DB,
		direction: 'dedicated_to_legacy',
		force: true,
	})

	const expired = await pruneSystemEmailRetention({
		db: env.APP_DB,
		blobs: env.EMAIL_BLOBS,
		timeBudgetMs: 0,
	})
	expect(expired.deletedThreads).toBe(0)

	const bounded = await pruneSystemEmailRetention({
		db: env.APP_DB,
		blobs: env.EMAIL_BLOBS,
		timeBudgetMs: 10_000,
	})
	expect(bounded.deletedThreads).toBe(40)
	expect(
		await env.APP_DB.prepare(
			`SELECT COUNT(*) AS count FROM system_email_threads
			WHERE id LIKE 'bounded-orphan-%'`,
		).first(),
	).toEqual({ count: 20 })
})

test('system email retention prunes dedicated authority without reading stale legacy rows', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const now = new Date('2026-07-06T12:00:00.000Z')
	const old = new Date(
		now.getTime() - (systemEmailLimits.retentionDays + 1) * 24 * 60 * 60 * 1000,
	).toISOString()
	const fresh = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
	const rawMimeKey = emailRawMimeKey(
		systemEmailOwnerId,
		'retention-old-message',
	)
	await env.EMAIL_BLOBS.put(rawMimeKey, 'old raw MIME')
	await env.APP_DB.batch([
		env.APP_DB.prepare(
			`INSERT INTO system_email_threads (
				id, inbox_id, subject_normalized, last_message_at, created_at, updated_at
			) VALUES ('retention-old-thread', NULL, 'old', ?, ?, ?)`,
		).bind(old, old, old),
		env.APP_DB.prepare(
			`INSERT INTO system_email_messages (
				id, direction, thread_id, from_address, processing_status,
				raw_mime_key, created_at, updated_at
			) VALUES (
				'retention-old-message', 'inbound', 'retention-old-thread',
				'old@example.net', 'stored', ?, ?, ?
			)`,
		).bind(rawMimeKey, old, old),
		env.APP_DB.prepare(
			`INSERT INTO system_email_attachments (
				id, message_id, content_type, size, storage_kind, created_at
			) VALUES (
				'retention-old-attachment', 'retention-old-message', 'text/plain',
				1, 'raw-mime', ?
			)`,
		).bind(old),
		env.APP_DB.prepare(
			`INSERT INTO system_email_delivery_events (
				id, message_id, event_type, provider, detail_json, created_at
			) VALUES (
				'retention-old-event', 'retention-old-message', 'received',
				'test', '{}', ?
			)`,
		).bind(old),
	])
	// The seed plus inclusive bound intentionally creates maxStoredMessages + 1.
	await env.APP_DB.prepare(
		`WITH RECURSIVE sequence(value) AS (
			VALUES(0)
			UNION ALL
			SELECT value + 1 FROM sequence WHERE value < ?
		)
		INSERT INTO system_email_messages (
			id, direction, from_address, processing_status, created_at, updated_at
		)
		SELECT printf('retention-cap-%04d', value), 'inbound',
			'cap@example.net', 'stored', ?, ?
		FROM sequence`,
	)
		.bind(systemEmailLimits.maxStoredMessages, fresh, fresh)
		.run()
	const initialMirror = await reconcileLegacySystemEmailGraphFromDedicated({
		db: env.APP_DB,
		direction: 'dedicated_to_legacy',
		force: true,
	})
	expect(initialMirror.postReport.parity).toBe(true)

	// A stale rollback-era legacy row must never flow back into authority.
	await env.APP_DB.prepare(
		`INSERT INTO email_messages (
			id, direction, user_id, from_address, processing_status,
			created_at, updated_at
		) VALUES (
			'legacy-only-after-cutover', 'inbound', ?, 'stale@example.net',
			'stored', ?, ?
		)`,
	)
		.bind(systemEmailOwnerId, fresh, fresh)
		.run()

	const result = await pruneSystemEmailRetention({
		db: env.APP_DB,
		blobs: env.EMAIL_BLOBS,
		now,
	})

	expect(result).toMatchObject({
		deletedMessages: 2,
		deletedThreads: 1,
		deletedRawMimeBlobs: 1,
		blobDeleteErrors: 0,
		authority: 'dedicated',
		warnings: [],
	})
	expect(await env.EMAIL_BLOBS.head(rawMimeKey)).toBeNull()
	const counts = await env.APP_DB.prepare(
		`SELECT
			(SELECT COUNT(*) FROM system_email_messages) AS dedicatedMessages,
			(SELECT COUNT(*) FROM email_messages WHERE user_id = ?) AS legacyMessages,
			(SELECT COUNT(*) FROM system_email_attachments) AS dedicatedAttachments,
			(SELECT COUNT(*) FROM system_email_delivery_events) AS dedicatedEvents`,
	)
		.bind(systemEmailOwnerId)
		.first<Record<string, number>>()
	expect(counts).toEqual({
		dedicatedMessages: systemEmailLimits.maxStoredMessages,
		legacyMessages: systemEmailLimits.maxStoredMessages + 1,
		dedicatedAttachments: 0,
		dedicatedEvents: 0,
	})
	expect(
		await env.APP_DB.prepare(
			`SELECT id FROM system_email_messages
			WHERE id = 'legacy-only-after-cutover'`,
		).first(),
	).toBeNull()
	expect(
		await loadSystemEmailGraphParityReport({ db: env.APP_DB }),
	).toMatchObject({
		messages: { missingFromDedicatedCount: 1, parity: false },
		parity: false,
	})
}, 30_000)
