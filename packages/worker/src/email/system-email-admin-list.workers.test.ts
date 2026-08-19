import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { systemEmailOwnerId } from './email-owner.ts'
import {
	getSystemEmailAdminMessageRow,
	insertSystemEmailMessage,
	listSystemEmailAdminMessages,
} from './system-email-graph-store.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

test('admin system email list stays one row when an inbox has several domain addresses', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const inboxId = `kody-inbox-${crypto.randomUUID()}`
	const messageId = `kody-message-${crypto.randomUUID()}`
	const now = '2026-08-19T00:00:00.000Z'
	await env.APP_DB.batch([
		env.APP_DB.prepare(
			`INSERT INTO email_inboxes (
				id, user_id, name, enabled, created_at, updated_at
			) VALUES (?, ?, 'kody', 1, ?, ?)`,
		).bind(inboxId, systemEmailOwnerId, now, now),
		...['kody.codes', 'heykody.app', 'heykody.dev'].map((domain) =>
			env.APP_DB.prepare(
				`INSERT INTO email_inbox_addresses (
					id, inbox_id, user_id, address, local_part, domain,
					enabled, created_at, updated_at
				) VALUES (?, ?, ?, ?, 'kody', ?, 1, ?, ?)`,
			).bind(
				crypto.randomUUID(),
				inboxId,
				systemEmailOwnerId,
				`kody@${domain}`,
				domain,
				now,
				now,
			),
		),
	])
	await insertSystemEmailMessage({
		db: env.APP_DB,
		message: {
			id: messageId,
			inboxId,
			fromAddress: 'no-reply@accounts.google.com',
			toAddresses: ['kody@kody.codes'],
			subject: 'Security alert',
			rawSize: 13746,
			processingStatus: 'stored',
			receivedAt: now,
		},
	})

	const list = await listSystemEmailAdminMessages({
		db: env.APP_DB,
		pageSize: 25,
		offset: 0,
	})
	expect(list.total).toBe(1)
	expect(list.rows).toHaveLength(1)
	expect(list.rows[0]).toMatchObject({
		id: messageId,
		inbox_local_part: 'kody',
		subject: 'Security alert',
		raw_size: 13746,
		to_addresses_json: '["kody@kody.codes"]',
	})

	const detail = await getSystemEmailAdminMessageRow({
		db: env.APP_DB,
		messageId,
	})
	expect(detail).toMatchObject({
		id: messageId,
		inbox_local_part: 'kody',
		subject: 'Security alert',
	})
})
