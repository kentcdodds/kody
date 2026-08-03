import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { systemEmailOwnerId } from './email-owner.ts'
import {
	deleteOutboundProviderIndexByMessageId,
	getOutboundProviderIndexRow,
	isOutboundProviderIndexForeignKeyDetached,
	loadOutboundProviderIndexHealthReport,
	upsertOutboundProviderIndexRow,
} from './outbound-provider-index.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

test('thin provider index persists independently of the frozen USER graph', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await expect(
		isOutboundProviderIndexForeignKeyDetached(env.APP_DB),
	).resolves.toBe(true)
	const userId = `index-user-${crypto.randomUUID()}`
	const messageId = `index-message-${crypto.randomUUID()}`
	const providerMessageId = `index-provider-${crypto.randomUUID()}`
	const now = '2026-08-03T02:00:00.000Z'

	await upsertOutboundProviderIndexRow({
		db: env.APP_DB,
		providerMessageId,
		userId,
		messageId,
		inboxId: null,
		now,
	})
	expect(
		await getOutboundProviderIndexRow({
			db: env.APP_DB,
			providerMessageId,
		}),
	).toMatchObject({ userId, messageId, providerMessageId })
	expect(
		await loadOutboundProviderIndexHealthReport({ db: env.APP_DB }),
	).toMatchObject({
		healthy: true,
		malformedCount: 0,
	})

	for (const table of [
		'email_threads',
		'email_messages',
		'email_attachments',
		'email_delivery_events',
	]) {
		const row = await env.APP_DB.prepare(
			`SELECT COUNT(*) AS count FROM ${table} WHERE ${
				table === 'email_attachments' ? 'message_id' : 'user_id'
			} = ?`,
		)
			.bind(table === 'email_attachments' ? messageId : userId)
			.first<{ count: number }>()
		expect(row?.count).toBe(0)
	}

	await deleteOutboundProviderIndexByMessageId({
		db: env.APP_DB,
		messageId,
	})
	await expect(
		getOutboundProviderIndexRow({ db: env.APP_DB, providerMessageId }),
	).resolves.toBeNull()
})

test('provider index rejects the dedicated system owner', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await expect(
		upsertOutboundProviderIndexRow({
			db: env.APP_DB,
			providerMessageId: `system-provider-${crypto.randomUUID()}`,
			userId: systemEmailOwnerId,
			messageId: `system-message-${crypto.randomUUID()}`,
			inboxId: null,
			now: new Date().toISOString(),
		}),
	).rejects.toThrow()
})
