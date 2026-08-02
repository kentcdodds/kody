import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import {
	loadSystemEmailGraphParityReport,
	reconcileSystemEmailGraphFromLegacy,
} from './system-email-graph-repo.ts'
import {
	pruneSystemEmailRetention,
	systemEmailLimits,
	systemEmailOwnerId,
} from './system-email.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

test('system delivery-event test schema enforces provider event uniqueness', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const statement = env.APP_DB.prepare(
		`INSERT INTO system_email_delivery_events (
			id, event_type, provider, provider_event_id, created_at
		) VALUES (?, 'received', 'test', 'system-provider-event-unique', ?)`,
	)
	await statement
		.bind('system-provider-event-a', new Date().toISOString())
		.run()
	await expect(
		statement.bind('system-provider-event-b', new Date().toISOString()).run(),
	).rejects.toThrow()
})

test('system email retention bounds the dedicated 4a graph and catches up live legacy rows', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const now = new Date('2026-07-06T12:00:00.000Z')
	const old = new Date(
		now.getTime() - (systemEmailLimits.retentionDays + 1) * 24 * 60 * 60 * 1000,
	).toISOString()
	const fresh = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
	await env.APP_DB.prepare(
		`INSERT INTO email_threads (
			id, user_id, inbox_id, subject_normalized, last_message_at,
			created_at, updated_at
		) VALUES (
			'retention-old-thread', ?, NULL, 'old', ?, ?, ?
		)`,
	)
		.bind(systemEmailOwnerId, old, old, old)
		.run()
	await env.APP_DB.prepare(
		`INSERT INTO email_messages (
			id, direction, user_id, thread_id, from_address, processing_status,
			created_at, updated_at
		) VALUES (
			'retention-old-message', 'inbound', ?, 'retention-old-thread',
			'old@example.net', 'stored', ?, ?
		)`,
	)
		.bind(systemEmailOwnerId, old, old)
		.run()
	await env.APP_DB.prepare(
		`INSERT INTO email_attachments (
			id, message_id, content_type, size, storage_kind, created_at
		) VALUES (
			'retention-old-attachment', 'retention-old-message', 'text/plain',
			1, 'raw-mime', ?
		)`,
	)
		.bind(old)
		.run()
	await env.APP_DB.prepare(
		`INSERT INTO email_delivery_events (
			id, message_id, user_id, event_type, provider, detail_json, created_at
		) VALUES (
			'retention-old-event', 'retention-old-message', ?, 'received',
			'test', '{}', ?
		)`,
	)
		.bind(systemEmailOwnerId, old)
		.run()
	await env.APP_DB.prepare(
		`WITH RECURSIVE sequence(value) AS (
			VALUES(0)
			UNION ALL
			SELECT value + 1
			FROM sequence
			WHERE value < ?
		)
		INSERT INTO email_messages (
			id, direction, user_id, from_address, processing_status,
			created_at, updated_at
		)
		SELECT
			printf('retention-cap-%04d', value),
			'inbound',
			?,
			'cap@example.net',
			'stored',
			?,
			?
		FROM sequence`,
	)
		.bind(systemEmailLimits.maxStoredMessages, systemEmailOwnerId, fresh, fresh)
		.run()

	const initialCopy = await reconcileSystemEmailGraphFromLegacy({
		db: env.APP_DB,
	})
	expect(initialCopy.postReport.parity).toBe(true)

	await env.APP_DB.prepare(
		`INSERT INTO email_threads (
			id, user_id, inbox_id, subject_normalized, last_message_at,
			created_at, updated_at
		) VALUES (
			'retention-live-thread', ?, NULL, 'live', ?, ?, ?
		)`,
	)
		.bind(
			systemEmailOwnerId,
			now.toISOString(),
			now.toISOString(),
			now.toISOString(),
		)
		.run()
	await env.APP_DB.prepare(
		`INSERT INTO email_messages (
			id, direction, user_id, thread_id, from_address, processing_status,
			created_at, updated_at
		) VALUES (
			'retention-live-message', 'inbound', ?, 'retention-live-thread',
			'live@example.net', 'stored', ?, ?
		)`,
	)
		.bind(systemEmailOwnerId, now.toISOString(), now.toISOString())
		.run()
	await env.APP_DB.batch([
		env.APP_DB.prepare(
			`INSERT INTO system_email_threads (
				id, inbox_id, subject_normalized, last_message_at, created_at, updated_at
			) VALUES (
				'retention-orphan-thread', NULL, 'orphan', ?, ?, ?
			)`,
		).bind(fresh, fresh, fresh),
		env.APP_DB.prepare(
			`INSERT INTO system_email_messages (
				id, direction, thread_id, from_address, processing_status,
				created_at, updated_at
			) VALUES (
				'retention-orphan-message', 'inbound', 'retention-orphan-thread',
				'orphan@example.net', 'stored', ?, ?
			)`,
		).bind(fresh, fresh),
		env.APP_DB.prepare(
			`INSERT INTO system_email_attachments (
				id, message_id, content_type, size, storage_kind, created_at
			) VALUES (
				'retention-orphan-attachment', 'retention-orphan-message',
				'text/plain', 1, 'raw-mime', ?
			)`,
		).bind(fresh),
		env.APP_DB.prepare(
			`INSERT INTO system_email_delivery_events (
				id, message_id, event_type, provider, detail_json, created_at
			) VALUES (
				'retention-orphan-event', 'retention-orphan-message', 'received',
				'test', '{}', ?
			)`,
		).bind(fresh),
	])

	const result = await pruneSystemEmailRetention({
		db: env.APP_DB,
		blobs: env.EMAIL_BLOBS,
		now,
	})

	expect(result.deletedMessages).toBe(3)
	expect(result.blobDeleteErrors).toBe(0)
	expect(result.dedicatedGraphSync).toEqual({
		status: 'reconciled',
		upserted: {
			threads: 1,
			messages: 1,
			attachments: 0,
			deliveryEvents: 0,
		},
		deleted: {
			threads: 2,
			messages: 4,
			attachments: 2,
			deliveryEvents: 2,
		},
		referencedOwnerMismatchCount: 0,
		parity: true,
	})
	expect(result.warnings).toEqual([])
	const counts = await env.APP_DB.prepare(
		`SELECT
			(SELECT COUNT(*) FROM email_messages WHERE user_id = ?)
				AS legacyMessages,
			(SELECT COUNT(*) FROM system_email_messages) AS dedicatedMessages,
			(SELECT COUNT(*) FROM system_email_attachments) AS dedicatedAttachments,
			(SELECT COUNT(*) FROM system_email_delivery_events) AS dedicatedEvents,
			(SELECT COUNT(*) FROM system_email_threads) AS dedicatedThreads`,
	)
		.bind(systemEmailOwnerId)
		.first<Record<string, number>>()
	expect(counts).toEqual({
		legacyMessages: systemEmailLimits.maxStoredMessages,
		dedicatedMessages: systemEmailLimits.maxStoredMessages,
		dedicatedAttachments: 0,
		dedicatedEvents: 0,
		dedicatedThreads: 1,
	})
	expect(
		await env.APP_DB.prepare(
			`SELECT id FROM system_email_messages
			WHERE id = 'retention-live-message'`,
		).first(),
	).toMatchObject({ id: 'retention-live-message' })
	expect(
		await loadSystemEmailGraphParityReport({ db: env.APP_DB }),
	).toMatchObject({ parity: true })
}, 30_000)
