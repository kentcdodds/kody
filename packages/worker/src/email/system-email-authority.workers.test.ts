import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import {
	loadAdminSystemEmailData,
	loadAdminSystemEmailMessageById,
} from '#worker/admin/system-email-data.ts'
import { countInternalSystemEmailMessages } from './mailbox-internal-read.ts'
import {
	createSystemEmailThread,
	getSystemEmailMessageById,
	insertSystemEmailAttachments,
	insertSystemEmailMessage,
	listSystemEmailMessages,
	updateSystemEmailMessageClassification,
} from './system-email-graph-store.ts'
import {
	chargeSystemInboundDeliveryOnce,
	recordBoundedSystemEmailRejection,
} from './system-inbound-delivery-store.ts'
import {
	loadSystemEmailGraphParityReport,
	reconcileLegacySystemEmailGraphFromDedicated,
} from './system-email-graph-repo.ts'
import { systemEmailOwnerId } from './email-owner.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

test('dedicated writes reject cross-owner references before either home commits', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await env.APP_DB.batch([
		env.APP_DB.prepare(
			`INSERT INTO email_inboxes (
				id, user_id, name, enabled, created_at, updated_at
			) VALUES (
				'foreign-write-inbox', 'foreign-user', 'private', 1,
				CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
			)`,
		),
		env.APP_DB.prepare(
			`INSERT INTO email_sender_identities (
				id, user_id, email, status, created_at, updated_at
			) VALUES (
				'foreign-write-sender', 'foreign-user', 'foreign@example.com',
				'verified', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
			)`,
		),
		env.APP_DB.prepare(
			`INSERT INTO email_threads (
				id, user_id, inbox_id, subject_normalized, last_message_at,
				created_at, updated_at
			) VALUES (
				'foreign-write-thread', 'foreign-user', 'foreign-write-inbox',
				'private', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
			)`,
		),
		env.APP_DB.prepare(
			`INSERT INTO email_messages (
				id, direction, user_id, inbox_id, thread_id, from_address,
				processing_status, created_at, updated_at
			) VALUES (
				'foreign-write-message', 'inbound', 'foreign-user',
				'foreign-write-inbox', 'foreign-write-thread', 'foreign@example.com',
				'stored', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
			)`,
		),
	])

	await expect(
		createSystemEmailThread({
			db: env.APP_DB,
			id: 'cross-owner-system-thread',
			inboxId: 'foreign-write-inbox',
		}),
	).rejects.toThrow()
	await expect(
		insertSystemEmailMessage({
			db: env.APP_DB,
			message: {
				id: 'cross-owner-system-message',
				inboxId: 'foreign-write-inbox',
				threadId: 'foreign-write-thread',
				senderIdentityId: 'foreign-write-sender',
				processingStatus: 'stored',
			},
		}),
	).rejects.toThrow()
	await expect(
		insertSystemEmailAttachments({
			db: env.APP_DB,
			messageId: 'foreign-write-message',
			attachments: [
				{
					id: 'cross-owner-system-attachment',
					storageKind: 'raw-mime',
				},
			],
		}),
	).rejects.toThrow()
	await expect(
		chargeSystemInboundDeliveryOnce({
			db: env.APP_DB,
			localPart: 'support',
			limit: 10,
			now: new Date('2026-08-03T00:00:00.000Z'),
			delivery: {
				deliveryId: 'cross-owner-system-event',
				messageId: 'cross-owner-event-message',
				threadId: 'cross-owner-event-thread',
				rawMimeKey: 'email-raw:v1:system:email/cross-owner-event-message',
				userId: systemEmailOwnerId,
				inboxId: 'foreign-write-inbox',
				recipient: 'support@example.com',
				envelopeFrom: 'sender@example.net',
				provider: 'cloudflare-email-routing',
				quotaDay: '2026-08-03',
				dedupeExpiresAt: '2026-08-05T00:00:00.000Z',
				fingerprint: 'cross-owner-event-fingerprint',
				state: 'pending',
			},
		}),
	).rejects.toThrow()

	expect(
		await env.APP_DB.prepare(
			`SELECT
				(SELECT COUNT(*) FROM system_email_threads
					WHERE id = 'cross-owner-system-thread') AS dedicated_threads,
				(SELECT COUNT(*) FROM email_threads
					WHERE id = 'cross-owner-system-thread') AS legacy_threads,
				(SELECT COUNT(*) FROM system_email_messages
					WHERE id = 'cross-owner-system-message') AS dedicated_messages,
				(SELECT COUNT(*) FROM email_messages
					WHERE id = 'cross-owner-system-message') AS legacy_messages,
				(SELECT COUNT(*) FROM system_email_attachments
					WHERE id = 'cross-owner-system-attachment') AS dedicated_attachments,
				(SELECT COUNT(*) FROM email_attachments
					WHERE id = 'cross-owner-system-attachment') AS legacy_attachments,
				(SELECT COUNT(*) FROM system_email_delivery_events
					WHERE id = 'cross-owner-system-event') AS dedicated_events,
				(SELECT COUNT(*) FROM email_delivery_events
					WHERE id = 'cross-owner-system-event') AS legacy_events`,
		).first(),
	).toEqual({
		dedicated_threads: 0,
		legacy_threads: 0,
		dedicated_messages: 0,
		legacy_messages: 0,
		dedicated_attachments: 0,
		legacy_attachments: 0,
		dedicated_events: 0,
		legacy_events: 0,
	})
})

test('dedicated system graph is the only read authority and remains user-isolated', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const createdAt = '2026-08-02T22:00:00.000Z'
	await env.APP_DB.prepare(
		`INSERT INTO email_messages (
			id, direction, user_id, from_address, subject, processing_status,
			created_at, updated_at
		) VALUES (
			'legacy-only-system', 'inbound', ?, 'legacy@example.net',
			'Must not be read', 'stored', ?, ?
		)`,
	)
		.bind(systemEmailOwnerId, createdAt, createdAt)
		.run()
	await insertSystemEmailMessage({
		db: env.APP_DB,
		message: {
			id: 'dedicated-system',
			fromAddress: 'sender@example.net',
			subject: 'Dedicated mail',
			processingStatus: 'stored',
			receivedAt: createdAt,
		},
	})

	expect(
		(await listSystemEmailMessages({ db: env.APP_DB, limit: 10 })).map(
			(message) => message.id,
		),
	).toEqual(['dedicated-system'])
	expect(await countInternalSystemEmailMessages({ env })).toBe(1)
	expect(
		await loadAdminSystemEmailMessageById(
			env.APP_DB,
			'legacy-only-system',
			env.EMAIL_BLOBS,
		),
	).toBeNull()
	const adminData = await loadAdminSystemEmailData(
		env,
		'https://kody.example.com/admin/system-email',
	)
	expect(adminData.total).toBe(1)
	expect(adminData.messages.map((message) => message.id)).toEqual([
		'dedicated-system',
	])
})

test('system graph writes mirror atomically and rollback repair is dedicated to legacy', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const thread = await createSystemEmailThread({
		db: env.APP_DB,
		id: 'system-thread',
		subjectNormalized: 'incident',
	})
	await insertSystemEmailMessage({
		db: env.APP_DB,
		message: {
			id: 'system-message',
			threadId: thread.id,
			fromAddress: 'sender@example.net',
			subject: 'Incident',
			processingStatus: 'stored',
		},
	})
	await insertSystemEmailAttachments({
		db: env.APP_DB,
		messageId: 'system-message',
		attachments: [
			{
				id: 'system-attachment',
				contentType: 'text/plain',
				size: 4,
				storageKind: 'raw-mime',
			},
		],
	})
	expect(
		await updateSystemEmailMessageClassification({
			db: env.APP_DB,
			messageId: 'system-message',
			classification: 'quarantined',
			classificationReason: 'test',
		}),
	).toBe(true)
	expect(
		await loadSystemEmailGraphParityReport({ db: env.APP_DB }),
	).toMatchObject({ parity: true })

	await env.APP_DB.prepare(
		`DELETE FROM email_attachments WHERE id = 'system-attachment'`,
	).run()
	await env.APP_DB.prepare(
		`UPDATE email_messages SET subject = 'stale legacy'
		WHERE id = 'system-message' AND user_id = ?`,
	)
		.bind(systemEmailOwnerId)
		.run()
	expect(
		await getSystemEmailMessageById({
			db: env.APP_DB,
			messageId: 'system-message',
		}),
	).toMatchObject({ subject: 'Incident', classification: 'quarantined' })

	const repair = await reconcileLegacySystemEmailGraphFromDedicated({
		db: env.APP_DB,
		direction: 'dedicated_to_legacy',
		force: true,
	})
	expect(repair.postReport.parity).toBe(true)
	expect(repair.metrics.upserted).toMatchObject({
		messages: 1,
		attachments: 1,
	})
})

test('legacy mirror failures roll back dedicated authority writes', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await env.APP_DB.prepare(
		`CREATE TRIGGER reject_system_legacy_message
		BEFORE INSERT ON email_messages
		WHEN NEW.user_id = 'system:email'
		BEGIN
			SELECT RAISE(ABORT, 'legacy mirror unavailable');
		END`,
	).run()
	await expect(
		insertSystemEmailMessage({
			db: env.APP_DB,
			message: {
				id: 'must-roll-back',
				fromAddress: 'sender@example.net',
				processingStatus: 'stored',
			},
		}),
	).rejects.toThrow('legacy mirror unavailable')
	expect(
		await env.APP_DB.prepare(
			`SELECT id FROM system_email_messages WHERE id = 'must-roll-back'`,
		).first(),
	).toBeNull()
	await env.APP_DB.prepare(`DROP TRIGGER reject_system_legacy_message`).run()
	await env.APP_DB.prepare(
		`CREATE TRIGGER ignore_system_legacy_message
		BEFORE INSERT ON email_messages
		WHEN NEW.user_id = 'system:email'
		BEGIN
			SELECT RAISE(IGNORE);
		END`,
	).run()
	await expect(
		insertSystemEmailMessage({
			db: env.APP_DB,
			message: {
				id: 'mirror-no-op-must-roll-back',
				fromAddress: 'sender@example.net',
				processingStatus: 'stored',
			},
		}),
	).rejects.toThrow()
	expect(
		await env.APP_DB.prepare(
			`SELECT id FROM system_email_messages
			WHERE id = 'mirror-no-op-must-roll-back'`,
		).first(),
	).toBeNull()
	await env.APP_DB.prepare(`DROP TRIGGER ignore_system_legacy_message`).run()
})

test('dedicated authority operations fail closed without the cutover marker', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await env.APP_DB.prepare(
		`DELETE FROM system_email_graph_authority WHERE singleton = 1`,
	).run()

	await expect(
		listSystemEmailMessages({ db: env.APP_DB, limit: 10 }),
	).rejects.toThrow('authority marker is missing or invalid')
	await expect(
		insertSystemEmailMessage({
			db: env.APP_DB,
			message: {
				id: 'marker-required',
				fromAddress: 'sender@example.net',
				processingStatus: 'stored',
			},
		}),
	).rejects.toThrow('authority marker is missing or invalid')
	expect(
		await env.APP_DB.prepare(
			`SELECT id FROM system_email_messages WHERE id = 'marker-required'`,
		).first(),
	).toBeNull()
})

test('dedicated authority operations fail closed if provider links appear after cutover', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const now = '2026-08-03T00:00:00.000Z'
	await env.APP_DB.prepare(
		`INSERT INTO email_messages (
			id, direction, user_id, from_address, processing_status,
			provider_message_id, created_at, updated_at
		) VALUES (
			'post-cutover-provider-link', 'outbound', ?, 'support@example.com',
			'sent', 'provider-message-after-cutover', ?, ?
		)`,
	)
		.bind(systemEmailOwnerId, now, now)
		.run()
	await expect(
		env.APP_DB.prepare(
			`INSERT INTO email_outbound_provider_index (
				provider, provider_message_id, user_id, message_id, created_at,
				updated_at
			) VALUES ('resend', 'provider-message-after-cutover', ?, ?, ?, ?)`,
		)
			.bind(systemEmailOwnerId, 'post-cutover-provider-link', now, now)
			.run(),
	).rejects.toThrow(/CHECK constraint failed/u)

	await expect(
		listSystemEmailMessages({ db: env.APP_DB, limit: 10 }),
	).rejects.toThrow('refuses unsupported provider links')
})

test('concurrent system rejection details stop exactly at the atomic daily limit', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const now = new Date('2026-08-03T12:00:00.000Z')
	const inboxId = `bounded-rejection-inbox-${crypto.randomUUID()}`
	const detailLimit = 5
	const attemptCount = 16
	await env.APP_DB.prepare(
		`INSERT INTO email_inboxes (
			id, user_id, name, description, enabled, created_at, updated_at
		) VALUES (?, ?, 'Bounded rejection test', '', 1, ?, ?)`,
	)
		.bind(inboxId, systemEmailOwnerId, now.toISOString(), now.toISOString())
		.run()

	const counts = await Promise.all(
		Array.from({ length: attemptCount }, (_unused, index) =>
			recordBoundedSystemEmailRejection({
				db: env.APP_DB,
				inboxId,
				recipient: `recipient-${index}@example.test`,
				reason: `reason-${index}`,
				phase: 'system-limit',
				now,
				detailLimit,
			}),
		),
	)
	expect(counts.toSorted((left, right) => left - right)).toEqual(
		Array.from({ length: attemptCount }, (_unused, index) => index + 1),
	)

	const aggregateId = `email-rejections:${inboxId}:2026-08-03`
	const aggregate = await env.APP_DB.prepare(
		`SELECT
			json_extract(dedicated.detail_json, '$.count') AS dedicated_count,
			json_extract(legacy.detail_json, '$.count') AS legacy_count
		FROM system_email_delivery_events dedicated
		INNER JOIN email_delivery_events legacy ON legacy.id = dedicated.id
		WHERE dedicated.id = ? AND legacy.user_id = ?`,
	)
		.bind(aggregateId, systemEmailOwnerId)
		.first()
	expect(aggregate).toEqual({
		dedicated_count: attemptCount,
		legacy_count: attemptCount,
	})

	const dedicatedDetails = await env.APP_DB.prepare(
		`SELECT id FROM system_email_delivery_events
		WHERE inbox_id = ? AND event_type = 'rejected' AND id != ?
		ORDER BY id`,
	)
		.bind(inboxId, aggregateId)
		.all<{ id: string }>()
	const legacyDetails = await env.APP_DB.prepare(
		`SELECT id FROM email_delivery_events
		WHERE user_id = ? AND inbox_id = ? AND event_type = 'rejected' AND id != ?
		ORDER BY id`,
	)
		.bind(systemEmailOwnerId, inboxId, aggregateId)
		.all<{ id: string }>()
	expect(dedicatedDetails.results).toHaveLength(detailLimit)
	expect(legacyDetails.results).toEqual(dedicatedDetails.results)
})

test('system event mirror fails closed on a user-owned id collision', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const now = new Date('2026-08-02T23:00:00.000Z')
	const eventId = 'email-rejections:collision-inbox:2026-08-02'
	await env.APP_DB.prepare(
		`INSERT INTO email_delivery_events (
			id, user_id, inbox_id, event_type, provider, detail_json, created_at
		) VALUES (?, 'user-1', NULL, 'rejected', 'test', '{}', ?)`,
	)
		.bind(eventId, now.toISOString())
		.run()

	await expect(
		recordBoundedSystemEmailRejection({
			db: env.APP_DB,
			inboxId: 'collision-inbox',
			recipient: 'support@example.com',
			reason: 'test',
			phase: 'system-limit',
			now,
			detailLimit: 0,
		}),
	).rejects.toThrow()
	expect(
		await env.APP_DB.prepare(
			`SELECT user_id FROM email_delivery_events WHERE id = ?`,
		)
			.bind(eventId)
			.first(),
	).toEqual({ user_id: 'user-1' })
	expect(
		await env.APP_DB.prepare(
			`SELECT id FROM system_email_delivery_events WHERE id = ?`,
		)
			.bind(eventId)
			.first(),
	).toBeNull()
})
