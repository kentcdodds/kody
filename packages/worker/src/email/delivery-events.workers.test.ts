import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { processCloudflareEmailDeliveryEvent } from './delivery-events.ts'
import { mailboxRpc } from './mailbox-client.ts'
import { upsertOutboundProviderIndexRow } from './outbound-provider-index.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

function providerEvent(input: {
	providerMessageId: string
	providerEventId: string
	status: 'delivered' | 'bounced'
	at: string
}) {
	return {
		type: `cf.email.sending.message.${input.status}`,
		source: {
			type: 'email.sending',
			zoneId: 'zone-1',
			domain: 'inbox.example.com',
		},
		payload: {
			eventId: input.providerEventId,
			messageId: input.providerMessageId,
			sender: 'user@inbox.example.com',
			recipient: 'recipient@example.net',
			terminal: true,
			delivery: { status: input.status },
		},
		metadata: {
			accountId: 'account-1',
			eventSubscriptionId: 'subscription-1',
			eventSchemaVersion: 1,
			eventTimestamp: input.at,
		},
	}
}

test('provider lifecycle resolves the thin D1 index and mutates only Mailbox', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `provider-user-${crypto.randomUUID()}`
	const messageId = `message-${crypto.randomUUID()}`
	const providerMessageId = `provider-${crypto.randomUUID()}`
	const createdAt = '2026-08-03T01:00:00.000Z'
	const mailbox = mailboxRpc({ env, userId })
	await mailbox.writeMessageGraph({
		ownerId: userId,
		message: {
			id: messageId,
			direction: 'outbound',
			inboxId: null,
			threadId: null,
			senderIdentityId: null,
			fromAddress: 'user@inbox.example.com',
			envelopeFrom: null,
			toAddresses: ['recipient@example.net'],
			ccAddresses: [],
			bccAddresses: [],
			replyToAddresses: [],
			subject: 'Delivery lifecycle',
			messageIdHeader: '<outbound@example.com>',
			inReplyToHeader: null,
			references: [],
			headers: {},
			authResults: null,
			textBody: 'Body',
			htmlBody: null,
			rawMimeKey: null,
			rawSize: 4,
			processingStatus: 'sent',
			classification: 'accepted',
			classificationReason: null,
			providerMessageId,
			deliveryStatus: null,
			deliveryStatusAt: null,
			error: null,
			receivedAt: null,
			sentAt: createdAt,
			createdAt,
			updatedAt: createdAt,
		},
		attachments: [],
	})
	await upsertOutboundProviderIndexRow({
		db: env.APP_DB,
		providerMessageId,
		userId,
		messageId,
		inboxId: null,
		now: createdAt,
	})

	const deliveredAt = '2026-08-03T01:02:00.000Z'
	const event = providerEvent({
		providerMessageId,
		providerEventId: `event-${crypto.randomUUID()}`,
		status: 'delivered',
		at: deliveredAt,
	})
	const recorded = await processCloudflareEmailDeliveryEvent({
		env,
		body: event,
	})
	expect(recorded).toMatchObject({
		outcome: 'recorded',
		message: {
			id: messageId,
			userId,
			deliveryStatus: 'delivered',
			deliveryStatusAt: deliveredAt,
		},
		event: { messageId, userId, eventType: 'delivered' },
	})
	expect(
		await processCloudflareEmailDeliveryEvent({ env, body: event }),
	).toMatchObject({ outcome: 'duplicate' })
	expect(await mailbox.getMessage({ messageId })).toMatchObject({
		deliveryStatus: 'delivered',
		deliveryStatusAt: deliveredAt,
	})
	expect(await mailbox.listDeliveryEvents({ messageId, limit: 10 })).toEqual([
		expect.objectContaining({
			eventType: 'delivered',
			providerMessageId,
		}),
	])

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
}, 30_000)
