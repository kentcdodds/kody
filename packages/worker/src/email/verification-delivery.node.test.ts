import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import {
	classifyVerificationDeliveryFailure,
	lookupTransactionalEmailDelivery,
	recordTransactionalEmailDeliveryEvent,
	registerTransactionalEmailDelivery,
} from './verification-delivery.ts'

async function createDeliveryTestDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureUsersTestSchema({ db, columns: ['email_verified_at'] })
	await db
		.prepare(
			`CREATE TABLE transactional_email_delivery_index (
				provider_message_id TEXT PRIMARY KEY NOT NULL,
				user_id INTEGER NOT NULL,
				kind TEXT NOT NULL,
				recipient TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
			)`,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			 VALUES ('blocked', 'blocked@example.com', 'hash', ?)`,
		)
		.bind('a'.repeat(64))
		.run()
	return db
}

test('classifyVerificationDeliveryFailure treats Fastmail RLR613 as a sender block', () => {
	expect(
		classifyVerificationDeliveryFailure({
			status: 'bounced',
			smtpResponse:
				'451 4.7.1 Data command rejected: kody.codes is blacklisted - RLR613',
			smtpEnhancedStatusCode: '4.7.1',
		}),
	).toBe('sender_block')
	expect(
		classifyVerificationDeliveryFailure({
			status: 'failed',
			smtpResponse: '550 5.7.1 Too new - RLR813',
		}),
	).toBe('sender_block')
	expect(
		classifyVerificationDeliveryFailure({
			status: 'bounced',
			smtpResponse: '550 5.1.1 mailbox unavailable',
		}),
	).toBe('other')
	expect(
		classifyVerificationDeliveryFailure({
			status: 'delivered',
			smtpResponse: 'kody.codes is blacklisted - RLR613',
		}),
	).toBeNull()
})

test('transactional verification delivery records bounce status and stops matching unknown ids', async () => {
	const db = await createDeliveryTestDb()
	await registerTransactionalEmailDelivery({
		db,
		providerMessageId: 'cf-message-1',
		userId: 1,
		recipient: 'blocked@example.com',
	})
	expect(
		await lookupTransactionalEmailDelivery({
			db,
			providerMessageId: 'cf-message-1',
		}),
	).toMatchObject({
		user_id: 1,
		kind: 'email_verification',
		recipient: 'blocked@example.com',
	})

	const first = await recordTransactionalEmailDeliveryEvent({
		db,
		providerMessageId: 'cf-message-1',
		deliveryStatus: 'bounced',
		eventTimestamp: '2026-08-27T23:20:00.000Z',
		smtpResponse:
			'451 4.7.1 Data command rejected: kody.codes is blacklisted - RLR613',
	})
	expect(first).toEqual({
		outcome: 'recorded',
		event: {
			userId: 1,
			kind: 'email_verification',
			recipient: 'blocked@example.com',
			status: 'bounced',
			class: 'sender_block',
			alreadyTerminal: false,
		},
	})

	const replay = await recordTransactionalEmailDeliveryEvent({
		db,
		providerMessageId: 'cf-message-1',
		deliveryStatus: 'bounced',
		eventTimestamp: '2026-08-27T23:21:00.000Z',
		smtpResponse:
			'451 4.7.1 Data command rejected: kody.codes is blacklisted - RLR613',
	})
	expect(replay).toMatchObject({
		outcome: 'recorded',
		event: { alreadyTerminal: true, class: 'sender_block' },
	})

	expect(
		await recordTransactionalEmailDeliveryEvent({
			db,
			providerMessageId: 'unknown-message',
			deliveryStatus: 'bounced',
			eventTimestamp: '2026-08-27T23:22:00.000Z',
		}),
	).toEqual({ outcome: 'unmatched' })

	const row = await db
		.prepare(
			`SELECT email_verification_delivery_status, email_verification_delivery_class, email_verification_delivery_detail
			 FROM users WHERE id = 1`,
		)
		.first<{
			email_verification_delivery_status: string
			email_verification_delivery_class: string
			email_verification_delivery_detail: string
		}>()
	expect(row).toMatchObject({
		email_verification_delivery_status: 'bounced',
		email_verification_delivery_class: 'sender_block',
	})
	expect(row?.email_verification_delivery_detail).toContain('RLR613')

	const laterGenericFailure = await recordTransactionalEmailDeliveryEvent({
		db,
		providerMessageId: 'cf-message-1',
		deliveryStatus: 'failed',
		eventTimestamp: '2026-08-27T23:23:00.000Z',
		smtpResponse: '550 5.7.1 policy rejected',
	})
	expect(laterGenericFailure).toMatchObject({
		outcome: 'recorded',
		event: { alreadyTerminal: true, class: 'sender_block' },
	})
	expect(
		await db
			.prepare(
				`SELECT email_verification_delivery_class FROM users WHERE id = 1`,
			)
			.first<{ email_verification_delivery_class: string }>(),
	).toEqual({ email_verification_delivery_class: 'sender_block' })
})
