import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import {
	createSystemEmailThread,
	insertSystemEmailAttachments,
	insertSystemEmailMessage,
	listSystemEmailMessages,
	updateSystemEmailMessageClassification,
} from './system-email-graph-store.ts'
import { loadSystemEmailHealth } from './system-email-health.ts'
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
