import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { processCloudflareEmailDeliveryEvent } from './delivery-events.ts'
import { mirrorMailboxMessageGraphFromD1 } from './mailbox-live-mirror.ts'
import {
	getEmailMessageById,
	insertEmailMessage,
	listEmailDeliveryEvents,
} from './repo.ts'
import { mailboxEnv, rpcFor } from './mailbox-test-helpers.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

function createDeliveryEvent(input: {
	eventId: string
	messageId: string
	status:
		| 'delivered'
		| 'deferred'
		| 'bounced'
		| 'failed'
		| 'rejected'
		| 'complained'
	eventTimestamp: string
}) {
	return {
		type: `cf.email.sending.message.${input.status}`,
		source: {
			type: 'email.sending',
			zoneId: 'zone-1',
			domain: 'inbox.example.com',
		},
		payload: {
			eventId: input.eventId,
			messageId: input.messageId,
			sender: 'user@inbox.example.com',
			recipient: 'recipient@example.net',
			subject: 'Delivery lifecycle',
			terminal: input.status !== 'deferred',
			delivery: {
				status: input.status,
				provider: 'external_smtp',
				smtpStatusCode: input.status === 'delivered' ? '250' : '451',
				smtpResponse:
					input.status === 'delivered'
						? '250 2.0.0 accepted'
						: '451 4.2.0 temporary failure',
			},
			...(input.status === 'deferred'
				? {
						bounce: {
							type: 'soft',
							classification: 'temporary_failure',
						},
					}
				: {}),
		},
		metadata: {
			accountId: 'account-1',
			eventSubscriptionId: 'subscription-1',
			eventSchemaVersion: 1,
			eventTimestamp: input.eventTimestamp,
		},
	}
}

test('provider delivery events are idempotent, ordered, and user scoped', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = 'delivery-user-1'
	const providerMessageId = `provider-${crypto.randomUUID()}`
	const message = await insertEmailMessage({
		db: env.APP_DB,
		message: {
			direction: 'outbound',
			userId,
			fromAddress: 'user@inbox.example.com',
			toAddresses: ['recipient@example.net'],
			subject: 'Delivery lifecycle',
			processingStatus: 'sent',
			providerMessageId,
			sentAt: '2026-07-17T20:00:00.000Z',
		},
	})

	const delivered = createDeliveryEvent({
		eventId: 'event-delivered',
		messageId: providerMessageId,
		status: 'delivered',
		eventTimestamp: '2026-07-17T20:02:00.000Z',
	})
	const recorded = await processCloudflareEmailDeliveryEvent({
		db: env.APP_DB,
		body: delivered,
	})
	expect(recorded.outcome).toBe('recorded')
	expect(recorded.event).toMatchObject({
		messageId: message.id,
		userId,
		eventType: 'delivered',
		providerEventId: 'event-delivered',
	})
	expect(recorded.message).toMatchObject({
		id: message.id,
		userId,
		processingStatus: 'sent',
		deliveryStatus: 'delivered',
		deliveryStatusAt: '2026-07-17T20:02:00.000Z',
	})

	const duplicate = await processCloudflareEmailDeliveryEvent({
		db: env.APP_DB,
		body: delivered,
	})
	expect(duplicate.outcome).toBe('duplicate')

	const conflictingDuplicate = await processCloudflareEmailDeliveryEvent({
		db: env.APP_DB,
		body: createDeliveryEvent({
			eventId: 'event-delivered',
			messageId: providerMessageId,
			status: 'bounced',
			eventTimestamp: '2026-07-17T20:05:00.000Z',
		}),
	})
	expect(conflictingDuplicate.outcome).toBe('stale')
	expect(
		await getEmailMessageById({
			db: env.APP_DB,
			userId,
			messageId: message.id,
		}),
	).toMatchObject({
		deliveryStatus: 'delivered',
		deliveryStatusAt: '2026-07-17T20:02:00.000Z',
	})
	expect(
		await listEmailDeliveryEvents({
			db: env.APP_DB,
			userId,
			messageId: message.id,
			limit: 10,
		}),
	).toHaveLength(1)

	const olderDeferred = createDeliveryEvent({
		eventId: 'event-deferred',
		messageId: providerMessageId,
		status: 'deferred',
		eventTimestamp: '2026-07-17T20:01:00.000Z',
	})
	expect(
		(
			await processCloudflareEmailDeliveryEvent({
				db: env.APP_DB,
				body: olderDeferred,
			})
		).outcome,
	).toBe('stale')

	const stored = await getEmailMessageById({
		db: env.APP_DB,
		userId,
		messageId: message.id,
	})
	expect(stored).toMatchObject({
		deliveryStatus: 'delivered',
		deliveryStatusAt: '2026-07-17T20:02:00.000Z',
	})

	const events = await listEmailDeliveryEvents({
		db: env.APP_DB,
		userId,
		messageId: message.id,
		limit: 10,
	})
	expect(events).toHaveLength(2)
	expect(events.map((event) => event.providerEventId).sort()).toEqual([
		'event-deferred',
		'event-delivered',
	])
	expect(JSON.parse(events[0]!.detailJson)).toEqual(
		expect.objectContaining({
			recipient: 'recipient@example.net',
			delivery: expect.objectContaining({ status: 'delivered' }),
		}),
	)
	expect(
		await listEmailDeliveryEvents({
			db: env.APP_DB,
			userId: 'different-user',
			limit: 10,
		}),
	).toEqual([])

	expect(
		(
			await processCloudflareEmailDeliveryEvent({
				db: env.APP_DB,
				body: createDeliveryEvent({
					eventId: 'event-unknown',
					messageId: 'unknown-provider-message',
					status: 'bounced',
					eventTimestamp: '2026-07-17T20:03:00.000Z',
				}),
			})
		).outcome,
	).toBe('unmatched')

	expect(
		(
			await processCloudflareEmailDeliveryEvent({
				db: env.APP_DB,
				body: {
					...delivered,
					type: 'cf.email.sending.message.bounced',
				},
			})
		).outcome,
	).toBe('invalid')
})

test('recorded provider delivery events mirror the D1 message graph to Mailbox when configured', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `delivery-mailbox-${crypto.randomUUID()}`
	const providerMessageId = `provider-${crypto.randomUUID()}`
	const message = await insertEmailMessage({
		db: env.APP_DB,
		message: {
			direction: 'outbound',
			userId,
			fromAddress: 'user@inbox.example.com',
			toAddresses: ['recipient@example.net'],
			subject: 'Mailbox mirror',
			processingStatus: 'sent',
			providerMessageId,
			sentAt: '2026-07-17T20:00:00.000Z',
		},
	})
	const mailbox = rpcFor(userId)
	// Warm the per-user DO before graph mirror (RPC timeout is ~1s).
	await mailbox.getMessage({ messageId: 'warmup-nonexistent' })

	const recorded = await processCloudflareEmailDeliveryEvent({
		db: env.APP_DB,
		body: createDeliveryEvent({
			eventId: 'event-mailbox-delivered',
			messageId: providerMessageId,
			status: 'delivered',
			eventTimestamp: '2026-07-17T20:02:00.000Z',
		}),
	})
	expect(recorded.outcome).toBe('recorded')
	if (!recorded.message) {
		throw new Error('Expected recorded provider delivery message.')
	}

	const summary = await mirrorMailboxMessageGraphFromD1({
		env: { ...env, ...mailboxEnv() },
		db: env.APP_DB,
		userId,
		messageId: message.id,
	})
	expect(summary).toMatchObject({
		messageId: message.id,
		message: { status: 'mirrored' },
		eventsTruncated: false,
	})
	expect(summary.events).toEqual([
		expect.objectContaining({
			eventId: recorded.event!.id,
			result: { status: 'mirrored' },
		}),
	])

	const events = await mailbox.listDeliveryEvents({
		messageId: message.id,
		limit: 10,
	})
	expect(events).toHaveLength(1)
	expect(events[0]).toMatchObject({
		eventType: 'delivered',
		provider: 'cloudflare-email',
		providerEventId: 'event-mailbox-delivered',
		providerMessageId,
	})
	expect(await mailbox.getMessage({ messageId: message.id })).toMatchObject({
		deliveryStatus: 'delivered',
		deliveryStatusAt: '2026-07-17T20:02:00.000Z',
	})
	expect(
		await getEmailMessageById({
			db: env.APP_DB,
			userId,
			messageId: message.id,
		}),
	).toMatchObject({
		deliveryStatus: 'delivered',
		deliveryStatusAt: '2026-07-17T20:02:00.000Z',
	})
}, 30_000)

test('recorded provider delivery graph mirror skips cleanly when MAILBOX is absent', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `delivery-no-mailbox-${crypto.randomUUID()}`
	const providerMessageId = `provider-${crypto.randomUUID()}`
	const message = await insertEmailMessage({
		db: env.APP_DB,
		message: {
			direction: 'outbound',
			userId,
			fromAddress: 'user@inbox.example.com',
			toAddresses: ['recipient@example.net'],
			subject: 'No mailbox binding',
			processingStatus: 'sent',
			providerMessageId,
			sentAt: '2026-07-17T20:00:00.000Z',
		},
	})

	const recorded = await processCloudflareEmailDeliveryEvent({
		db: env.APP_DB,
		body: createDeliveryEvent({
			eventId: 'event-no-mailbox',
			messageId: providerMessageId,
			status: 'delivered',
			eventTimestamp: '2026-07-17T20:02:00.000Z',
		}),
	})
	expect(recorded.outcome).toBe('recorded')
	if (!recorded.message) {
		throw new Error('Expected recorded provider delivery message.')
	}

	expect(
		await mirrorMailboxMessageGraphFromD1({
			env: { APP_DB: env.APP_DB },
			db: env.APP_DB,
			userId,
			messageId: message.id,
		}),
	).toEqual({
		messageId: message.id,
		message: { status: 'skipped', reason: 'mailbox-unconfigured' },
		events: [
			{
				eventId: recorded.event!.id,
				result: { status: 'skipped', reason: 'mailbox-unconfigured' },
			},
		],
		eventsTruncated: false,
	})
})
