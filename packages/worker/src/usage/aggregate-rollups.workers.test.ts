import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { insertEmailMessage } from '#worker/email/repo.ts'
import { ensureEmailTestSchema } from '#worker/email/test-schema.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { readIdempotentInboundEmailUsage } from './aggregate-rollups.ts'

test('durable inbound usage survives message deletion and null message_id', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const email = `usage-deletion-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	await env.APP_DB.prepare(
		`INSERT INTO users (
			username, email, password_hash, email_verified_at, stable_user_id, plan
		) VALUES (?, ?, 'test-password', ?, ?, 'max')
		ON CONFLICT(email) DO UPDATE SET
			deleting_at = NULL,
			stable_user_id = excluded.stable_user_id`,
	)
		.bind(
			`usage-deletion-${crypto.randomUUID().slice(0, 8)}`,
			email,
			new Date().toISOString(),
			userId,
		)
		.run()
	const messageId = crypto.randomUUID()
	await insertEmailMessage({
		db: env.APP_DB,
		message: {
			id: messageId,
			direction: 'inbound',
			userId,
			rawSize: 321,
			processingStatus: 'stored',
			receivedAt: '2026-07-31T23:59:59.000Z',
		},
	})
	await env.APP_DB.prepare(
		`INSERT INTO email_delivery_events (
			id, message_id, user_id, event_type, provider, detail_json, created_at
		) VALUES (?, ?, ?, 'received', 'cloudflare-email-routing', ?, ?)`,
	)
		.bind(
			crypto.randomUUID(),
			messageId,
			userId,
			JSON.stringify({
				usageEffectRecordedAt: '2026-07-31T23:59:59.500Z',
				usageMonth: '2026-07',
				usageBytes: 321,
				usageDurationMs: 45,
			}),
			'2026-07-31T23:59:59.000Z',
		)
		.run()

	await env.APP_DB.prepare(
		`DELETE FROM email_messages WHERE id = ? AND user_id = ?`,
	)
		.bind(messageId, userId)
		.run()
	await env.APP_DB.prepare(
		`UPDATE email_delivery_events
		SET message_id = NULL
		WHERE message_id = ? AND user_id = ?`,
	)
		.bind(messageId, userId)
		.run()

	expect(
		await readIdempotentInboundEmailUsage({
			db: env.APP_DB,
			months: ['2026-08', '2026-07'],
		}),
	).toEqual([
		{
			user_id: userId,
			metric: 'email_received',
			month: '2026-07',
			event_count: 1,
			error_count: 0,
			total_duration_ms: 45,
			total_cpu_ms: 0,
			total_bytes: 321,
		},
	])
})
