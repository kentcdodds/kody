import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import {
	createSystemEmailThread,
	insertSystemEmailAttachments,
	insertSystemEmailMessage,
	listSystemEmailMessages,
	updateSystemEmailMessageClassification,
} from './system-email-graph-store.ts'
import { systemEmailOwnerId } from './email-owner.ts'
import { loadSystemEmailHealth } from './system-email-health.ts'
import { recordBoundedSystemEmailRejection } from './system-inbound-rejection-store.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

test('dedicated system graph enforces config ownership and reports health', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await env.APP_DB.batch([
		env.APP_DB.prepare(
			`INSERT INTO email_inboxes (
				id, user_id, name, enabled, created_at, updated_at
			) VALUES (
				'foreign-inbox', 'foreign-user', 'private', 1,
				CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
			)`,
		),
		env.APP_DB.prepare(
			`INSERT INTO email_sender_identities (
				id, user_id, email, status, created_at, updated_at
			) VALUES (
				'foreign-sender', 'foreign-user', 'foreign@example.test',
				'verified', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
			)`,
		),
	])
	await expect(
		createSystemEmailThread({
			db: env.APP_DB,
			id: 'cross-owner-thread',
			inboxId: 'foreign-inbox',
		}),
	).rejects.toThrow()
	await expect(
		insertSystemEmailMessage({
			db: env.APP_DB,
			message: {
				id: 'cross-owner-message',
				inboxId: 'foreign-inbox',
				senderIdentityId: 'foreign-sender',
				processingStatus: 'stored',
			},
		}),
	).rejects.toThrow()
	await expect(
		insertSystemEmailAttachments({
			db: env.APP_DB,
			messageId: 'foreign-owner-message',
			attachments: [
				{
					id: 'cross-owner-attachment',
					contentType: 'text/plain',
					storageKind: 'raw-mime',
				},
			],
		}),
	).rejects.toThrow('rejected an invalid dedicated reference')
	expect(
		await env.APP_DB.prepare(
			`SELECT id FROM system_email_attachments
			WHERE id = 'cross-owner-attachment'`,
		).first(),
	).toBeNull()
	await expect(
		recordBoundedSystemEmailRejection({
			db: env.APP_DB,
			inboxId: 'foreign-inbox',
			recipient: 'foreign@example.test',
			reason: 'cross-owner',
			phase: 'test',
			now: new Date('2026-08-03T12:00:00.000Z'),
			detailLimit: 1,
		}),
	).rejects.toThrow('returned an invalid count')
	expect(
		await env.APP_DB.prepare(
			`SELECT id FROM system_email_delivery_events
			WHERE inbox_id = 'foreign-inbox'`,
		).first(),
	).toBeNull()

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
			fromAddress: 'sender@example.test',
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
		(await listSystemEmailMessages({ db: env.APP_DB, limit: 10 })).map(
			(message) => message.id,
		),
	).toEqual(['system-message'])
	expect(await loadSystemEmailHealth({ db: env.APP_DB })).toMatchObject({
		authority: { authority: 'dedicated' },
		counts: {
			threads: 1,
			messages: 1,
			attachments: 1,
			deliveryEvents: 0,
		},
		invalidReferenceCount: 0,
		providerLinkCount: 0,
		healthy: true,
	})
})

test('system attachment inserts fail when an inbound delivery fence writes zero', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const messageId = `fenced-message-${crypto.randomUUID()}`
	const deliveryId = `fenced-delivery-${crypto.randomUUID()}`
	await insertSystemEmailMessage({
		db: env.APP_DB,
		message: {
			id: messageId,
			fromAddress: 'sender@example.test',
			processingStatus: 'stored',
		},
	})
	await env.APP_DB.prepare(
		`INSERT INTO system_email_delivery_events (
			id, message_id, event_type, provider, detail_json, state,
			storage_lease, created_at, updated_at
		) VALUES (?, ?, 'received', 'test', '{}', 'storing', 'current-lease',
			CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
	)
		.bind(deliveryId, messageId)
		.run()

	await expect(
		insertSystemEmailAttachments({
			db: env.APP_DB,
			messageId,
			ignoreConflicts: true,
			inboundDeliveryFence: {
				deliveryId,
				storageLease: 'stale-lease',
			},
			attachments: [
				{
					id: `fenced-attachment-${crypto.randomUUID()}`,
					contentType: 'text/plain',
					storageKind: 'raw-mime',
				},
			],
		}),
	).rejects.toThrow('storage lease was lost')
})

test('concurrent system rejection auditing keeps the detail bound exact', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await env.APP_DB.prepare(
		`INSERT INTO email_inboxes (
			id, user_id, name, enabled, created_at, updated_at
		) VALUES (
			'system-rejection-inbox', ?, 'support', 1,
			CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
		)`,
	)
		.bind(systemEmailOwnerId)
		.run()
	const attemptCount = 24
	const detailLimit = 5
	const counts = await Promise.all(
		Array.from({ length: attemptCount }, (_, index) =>
			recordBoundedSystemEmailRejection({
				db: env.APP_DB,
				inboxId: 'system-rejection-inbox',
				recipient: `recipient-${index}@example.test`,
				reason: `reason-${index}`,
				phase: 'system-limit',
				now: new Date('2026-08-03T12:00:00.000Z'),
				detailLimit,
			}),
		),
	)
	expect(counts.toSorted((left, right) => left - right)).toEqual(
		Array.from({ length: attemptCount }, (_, index) => index + 1),
	)
	const aggregateId = 'email-rejections:system-rejection-inbox:2026-08-03'
	expect(
		await env.APP_DB.prepare(
			`SELECT json_extract(detail_json, '$.count') AS count
			FROM system_email_delivery_events WHERE id = ?`,
		)
			.bind(aggregateId)
			.first(),
	).toEqual({ count: attemptCount })
	expect(
		await env.APP_DB.prepare(
			`SELECT COUNT(*) AS count FROM system_email_delivery_events
			WHERE inbox_id = 'system-rejection-inbox' AND id != ?`,
		)
			.bind(aggregateId)
			.first(),
	).toEqual({ count: detailLimit })
})

test('dedicated system operations fail closed on marker or provider-link drift', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await env.APP_DB.prepare(
		`DELETE FROM system_email_graph_authority WHERE singleton = 1`,
	).run()
	await expect(
		listSystemEmailMessages({ db: env.APP_DB, limit: 10 }),
	).rejects.toThrow('authority marker is missing or invalid')

	await ensureEmailTestSchema(env.APP_DB)
	await env.APP_DB.prepare(
		`INSERT INTO system_email_messages (
			id, direction, from_address, processing_status, provider_message_id,
			created_at, updated_at
		) VALUES (
			'unsupported-outbound', 'outbound', 'support@example.test', 'sent',
			'provider-id', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
		)`,
	).run()
	await expect(
		listSystemEmailMessages({ db: env.APP_DB, limit: 10 }),
	).rejects.toThrow('refuses unsupported provider links')
})
