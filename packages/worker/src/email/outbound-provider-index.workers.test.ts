import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { processCloudflareEmailDeliveryEvent } from './delivery-events.ts'
import {
	deleteOutboundProviderIndexByMessageId,
	emailOutboundProviderCloudflare,
	getOutboundProviderIndexRow,
	loadOutboundProviderIndexParityReport,
} from './outbound-provider-index.ts'
import { OutboundEmailPersistenceError, sendOutboundEmail } from './outbound.ts'
import {
	deleteEmailMessageById,
	getEmailMessageById,
	getOutboundEmailMessageByProviderMessageId,
	insertEmailMessage,
	listEmailDeliveryEvents,
	updateEmailMessageDelivery,
} from './repo.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

const platformBaseUrl = 'https://kody.example.com'

function createBindingSendEnv() {
	return {
		...env,
		APP_BASE_URL: platformBaseUrl,
		EMAIL: {
			async send() {
				return { messageId: `provider-send-${crypto.randomUUID()}` }
			},
		},
	}
}

async function seedVerifiedAccount(email: string) {
	const username = `idx-send-${crypto.randomUUID().slice(0, 8)}`
	const stableUserId = await createStableUserIdFromEmail(email)
	await env.APP_DB.prepare(
		`INSERT INTO users (
			username, email, password_hash, email_verified_at, plan, stable_user_id
		) VALUES (?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			username,
			email,
			'test-password-hash',
			new Date().toISOString(),
			'max',
			stableUserId,
		)
		.run()
	return stableUserId
}

test('insert and delivery update dual-write the outbound provider index', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `idx-user-${crypto.randomUUID()}`
	const providerMessageId = `provider-${crypto.randomUUID()}`
	const message = await insertEmailMessage({
		db: env.APP_DB,
		message: {
			direction: 'outbound',
			userId,
			inboxId: null,
			fromAddress: 'user@inbox.example.com',
			toAddresses: ['recipient@example.net'],
			subject: 'Index dual-write',
			processingStatus: 'sent',
			providerMessageId,
			sentAt: '2026-08-01T12:00:00.000Z',
		},
	})

	expect(
		await getOutboundProviderIndexRow({
			db: env.APP_DB,
			providerMessageId,
		}),
	).toMatchObject({
		provider: emailOutboundProviderCloudflare,
		providerMessageId,
		userId,
		messageId: message.id,
		inboxId: null,
	})

	const rotatedProviderMessageId = `provider-rotated-${crypto.randomUUID()}`
	await updateEmailMessageDelivery({
		db: env.APP_DB,
		messageId: message.id,
		status: 'sent',
		providerMessageId: rotatedProviderMessageId,
		sentAt: '2026-08-01T12:01:00.000Z',
	})

	expect(
		await getOutboundProviderIndexRow({
			db: env.APP_DB,
			providerMessageId,
		}),
	).toBeNull()
	expect(
		await getOutboundProviderIndexRow({
			db: env.APP_DB,
			providerMessageId: rotatedProviderMessageId,
		}),
	).toMatchObject({
		messageId: message.id,
		userId,
	})
	expect(
		await loadOutboundProviderIndexParityReport({
			db: env.APP_DB,
			userId,
		}),
	).toMatchObject({
		linkedMessageCount: 1,
		indexCount: 1,
		parity: true,
	})
})

test('provider delivery lifecycle resolves through the index for user and system owners', async () => {
	await ensureEmailTestSchema(env.APP_DB)

	for (const userId of [
		`idx-lifecycle-${crypto.randomUUID()}`,
		'system:email',
	]) {
		const providerMessageId = `provider-${crypto.randomUUID()}`
		const message = await insertEmailMessage({
			db: env.APP_DB,
			message: {
				direction: 'outbound',
				userId,
				fromAddress: 'sender@inbox.example.com',
				toAddresses: ['recipient@example.net'],
				subject: 'Lifecycle',
				processingStatus: 'sent',
				providerMessageId,
				sentAt: '2026-08-01T13:00:00.000Z',
			},
		})

		expect(
			await getOutboundEmailMessageByProviderMessageId({
				db: env.APP_DB,
				providerMessageId,
			}),
		).toMatchObject({ id: message.id, userId })

		const recorded = await processCloudflareEmailDeliveryEvent({
			db: env.APP_DB,
			body: {
				type: 'cf.email.sending.message.delivered',
				source: {
					type: 'email.sending',
					zoneId: 'zone-1',
					domain: 'inbox.example.com',
				},
				payload: {
					eventId: `event-${crypto.randomUUID()}`,
					messageId: providerMessageId,
					sender: 'sender@inbox.example.com',
					recipient: 'recipient@example.net',
					subject: 'Lifecycle',
					terminal: true,
					delivery: {
						status: 'delivered',
						provider: 'external_smtp',
						smtpStatusCode: '250',
						smtpResponse: '250 2.0.0 accepted',
					},
				},
				metadata: {
					accountId: 'account-1',
					eventSubscriptionId: 'subscription-1',
					eventSchemaVersion: 1,
					eventTimestamp: '2026-08-01T13:02:00.000Z',
				},
			},
		})
		expect(recorded.outcome).toBe('recorded')
		expect(recorded.message).toMatchObject({
			id: message.id,
			userId,
			deliveryStatus: 'delivered',
		})

		const duplicate = await processCloudflareEmailDeliveryEvent({
			db: env.APP_DB,
			body: {
				type: 'cf.email.sending.message.delivered',
				source: {
					type: 'email.sending',
					zoneId: 'zone-1',
					domain: 'inbox.example.com',
				},
				payload: {
					eventId: recorded.event!.providerEventId,
					messageId: providerMessageId,
					sender: 'sender@inbox.example.com',
					recipient: 'recipient@example.net',
					terminal: true,
					delivery: {
						status: 'delivered',
						provider: 'external_smtp',
					},
				},
				metadata: {
					accountId: 'account-1',
					eventSubscriptionId: 'subscription-1',
					eventSchemaVersion: 1,
					eventTimestamp: '2026-08-01T13:02:00.000Z',
				},
			},
		})
		expect(duplicate.outcome).toBe('duplicate')
	}

	await deleteOutboundProviderIndexByMessageId({
		db: env.APP_DB,
		messageId: 'missing',
	})
	expect(
		(
			await processCloudflareEmailDeliveryEvent({
				db: env.APP_DB,
				body: {
					type: 'cf.email.sending.message.bounced',
					source: {
						type: 'email.sending',
						zoneId: 'zone-1',
						domain: 'inbox.example.com',
					},
					payload: {
						eventId: `event-${crypto.randomUUID()}`,
						messageId: 'unknown-provider-message',
						sender: 'sender@inbox.example.com',
						recipient: 'recipient@example.net',
						terminal: true,
						delivery: { status: 'bounced' },
					},
					metadata: {
						accountId: 'account-1',
						eventSubscriptionId: 'subscription-1',
						eventSchemaVersion: 1,
						eventTimestamp: '2026-08-01T13:03:00.000Z',
					},
				},
			})
		).outcome,
	).toBe('unmatched')
})

test('deleteEmailMessageById removes the derived provider index row', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `idx-delete-${crypto.randomUUID()}`
	const providerMessageId = `provider-${crypto.randomUUID()}`
	const message = await insertEmailMessage({
		db: env.APP_DB,
		message: {
			direction: 'outbound',
			userId,
			fromAddress: 'user@inbox.example.com',
			toAddresses: ['recipient@example.net'],
			subject: 'Delete index',
			processingStatus: 'sent',
			providerMessageId,
			sentAt: '2026-08-01T14:00:00.000Z',
		},
	})

	const deletion = await deleteEmailMessageById({
		db: env.APP_DB,
		blobs: env.EMAIL_BLOBS,
		messageId: message.id,
		expectedUserId: userId,
	})
	expect(deletion.messageFound).toBe(true)
	expect(
		await getOutboundProviderIndexRow({
			db: env.APP_DB,
			providerMessageId,
		}),
	).toBeNull()
	expect(
		await getOutboundEmailMessageByProviderMessageId({
			db: env.APP_DB,
			providerMessageId,
		}),
	).toBeNull()
})

test('parity report flags missing and mismatched index rows', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `idx-parity-${crypto.randomUUID()}`
	const providerMessageId = `provider-${crypto.randomUUID()}`
	const message = await insertEmailMessage({
		db: env.APP_DB,
		message: {
			direction: 'outbound',
			userId,
			fromAddress: 'user@inbox.example.com',
			toAddresses: ['recipient@example.net'],
			subject: 'Parity',
			processingStatus: 'sent',
			providerMessageId,
			sentAt: '2026-08-01T15:00:00.000Z',
		},
	})
	await env.APP_DB.prepare(
		`DELETE FROM email_outbound_provider_index WHERE message_id = ?`,
	)
		.bind(message.id)
		.run()
	// Index row points at a real message that is not a linked outbound provider
	// row (no provider_message_id), so FK stays satisfied while parity flags
	// missing_from_messages.
	const orphanHost = await insertEmailMessage({
		db: env.APP_DB,
		message: {
			direction: 'outbound',
			userId,
			fromAddress: 'user@inbox.example.com',
			toAddresses: ['recipient@example.net'],
			subject: 'Orphan host',
			processingStatus: 'stored',
			providerMessageId: null,
		},
	})
	await env.APP_DB.prepare(
		`INSERT INTO email_outbound_provider_index (
			provider, provider_message_id, user_id, message_id, inbox_id,
			created_at, updated_at
		) VALUES (?, ?, ?, ?, NULL, ?, ?)`,
	)
		.bind(
			emailOutboundProviderCloudflare,
			`orphan-${crypto.randomUUID()}`,
			userId,
			orphanHost.id,
			'2026-08-01T15:00:00.000Z',
			'2026-08-01T15:00:00.000Z',
		)
		.run()

	const report = await loadOutboundProviderIndexParityReport({
		db: env.APP_DB,
		userId,
	})
	expect(report).toMatchObject({
		parity: false,
		linkedMessageCount: 1,
		indexCount: 1,
		missingFromIndexCount: 1,
		missingFromMessagesCount: 1,
	})
	expect(report).not.toHaveProperty('sampleMismatches')
})

test('sendOutboundEmail dual-writes the provider index on terminal success', async () => {
	silenceIncidentalRuntimeWarnings()
	await ensureEmailTestSchema(env.APP_DB)
	const email = `idx-send-${crypto.randomUUID()}@example.com`
	const userId = await seedVerifiedAccount(email)

	const result = await sendOutboundEmail({
		env: createBindingSendEnv(),
		userId,
		accountEmail: email,
		recipientPolicy: 'self',
		subject: 'Outbound index',
		text: 'hello',
	})
	expect(result.status).toBe('sent')
	expect(result.providerMessageId).toEqual(expect.any(String))
	expect(
		await getOutboundProviderIndexRow({
			db: env.APP_DB,
			providerMessageId: result.providerMessageId!,
		}),
	).toMatchObject({
		userId,
		messageId: result.message.id,
		provider: emailOutboundProviderCloudflare,
	})
	expect(
		await loadOutboundProviderIndexParityReport({
			db: env.APP_DB,
			userId,
		}),
	).toMatchObject({ parity: true, linkedMessageCount: 1, indexCount: 1 })
}, 30_000)

test('sendOutboundEmail retains provider acceptance when terminal D1 persistence fails', async () => {
	silenceIncidentalRuntimeWarnings([
		'email-outbound-terminal-persistence-failed',
	])
	await ensureEmailTestSchema(env.APP_DB)
	const email = `idx-persist-fail-${crypto.randomUUID()}@example.com`
	const userId = await seedVerifiedAccount(email)
	const acceptedProviderMessageId = `provider-accepted-${crypto.randomUUID()}`
	let providerCalls = 0
	const failingDb = new Proxy(env.APP_DB, {
		get(target, property, receiver) {
			if (property === 'batch') {
				return async (
					statements: Parameters<D1Database['batch']>[0],
				): Promise<ReturnType<D1Database['batch']>> => {
					// Fail only terminal update+index batches (2+ statements).
					if (statements.length >= 2) {
						throw new Error('injected terminal persistence failure')
					}
					return target.batch(statements)
				}
			}
			const value = Reflect.get(target, property, receiver)
			return typeof value === 'function'
				? (value as (...args: Array<unknown>) => unknown).bind(target)
				: value
		},
	})

	const error = await sendOutboundEmail({
		env: {
			...createBindingSendEnv(),
			APP_DB: failingDb,
			EMAIL: {
				async send() {
					providerCalls += 1
					return { messageId: acceptedProviderMessageId }
				},
			},
		},
		userId,
		accountEmail: email,
		recipientPolicy: 'self',
		subject: 'Persistence failure',
		text: 'hello',
	}).catch((caught: unknown) => caught)

	expect(error).toBeInstanceOf(OutboundEmailPersistenceError)
	expect(error).toMatchObject({
		messageId: expect.any(String),
		providerMessageId: acceptedProviderMessageId,
	})
	expect(providerCalls).toBe(1)

	const messageId = (error as OutboundEmailPersistenceError).messageId
	expect(
		await getEmailMessageById({
			db: env.APP_DB,
			userId,
			messageId,
		}),
	).toMatchObject({
		processingStatus: 'stored',
		providerMessageId: null,
		error: null,
	})
	expect(
		await getOutboundProviderIndexRow({
			db: env.APP_DB,
			providerMessageId: acceptedProviderMessageId,
		}),
	).toBeNull()
	const events = await listEmailDeliveryEvents({
		db: env.APP_DB,
		userId,
		messageId,
		limit: 20,
	})
	expect(events.map((event) => event.eventType).sort()).toEqual([
		'send_requested',
	])
	expect(events.some((event) => event.eventType === 'failed')).toBe(false)
}, 30_000)
