import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import {
	loadAdminSystemEmailData,
	loadAdminSystemEmailMessageById,
} from '#worker/admin/system-email-data.ts'
import { countInternalSystemEmailMessages } from './mailbox-internal-read.ts'
import { insertEmailMessage } from './repo.ts'
import {
	createSystemEmailThread,
	getSystemEmailMessageById,
	insertSystemEmailAttachments,
	insertSystemEmailMessage,
	listSystemEmailMessages,
	updateSystemEmailMessageClassification,
} from './system-email-graph-store.ts'
import { recordBoundedSystemEmailRejection } from './system-inbound-delivery-store.ts'
import {
	loadSystemEmailGraphParityReport,
	reconcileLegacySystemEmailGraphFromDedicated,
} from './system-email-graph-repo.ts'
import { systemEmailOwnerId } from './email-owner.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

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
	await insertEmailMessage({
		db: env.APP_DB,
		message: {
			id: 'user-only-message',
			direction: 'inbound',
			userId: 'user-1',
			fromAddress: 'user@example.net',
			subject: 'User mail',
			processingStatus: 'stored',
			receivedAt: createdAt,
		},
	})
	await insertSystemEmailMessage({
		db: env.APP_DB,
		message: {
			id: 'dedicated-system',
			direction: 'inbound',
			userId: systemEmailOwnerId,
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
			direction: 'inbound',
			userId: systemEmailOwnerId,
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

test('legacy mirror failure rolls back authority and system outbound is unsupported', async () => {
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
				direction: 'inbound',
				userId: systemEmailOwnerId,
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
				direction: 'inbound',
				userId: systemEmailOwnerId,
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

	await expect(
		insertSystemEmailMessage({
			db: env.APP_DB,
			message: {
				id: 'system-outbound',
				direction: 'outbound',
				userId: systemEmailOwnerId,
				fromAddress: 'support@example.com',
				processingStatus: 'stored',
			},
		}),
	).rejects.toThrow('System outbound email is unsupported')
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
				direction: 'inbound',
				userId: systemEmailOwnerId,
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
	await env.APP_DB.prepare(
		`INSERT INTO email_outbound_provider_index (
			provider, provider_message_id, user_id, message_id, created_at,
			updated_at
		) VALUES ('resend', 'provider-message-after-cutover', ?, ?, ?, ?)`,
	)
		.bind(systemEmailOwnerId, 'post-cutover-provider-link', now, now)
		.run()

	await expect(
		listSystemEmailMessages({ db: env.APP_DB, limit: 10 }),
	).rejects.toThrow('refuses unsupported provider links')
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
