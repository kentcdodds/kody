import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'
import { createUserInboundDeliveryAuthority } from './inbound-delivery-authority.ts'
import {
	buildInboundDelivery,
	inboundDeliveryDedupeWindowMs,
	InboundDeliveryLeaseLostError,
} from './inbound-delivery.ts'
import { replaceInboundDueOwnerHint } from './inbound-due-owners.ts'
import { handleInboundEmail } from './inbound.ts'
import { mailboxRpc } from './mailbox-client.ts'
import { mailboxInboundStorageLeaseMs } from './mailbox-inbound-ledger-shared.ts'
import {
	baseMessage,
	baseThread,
	uniqueUserId,
} from './mailbox-test-helpers.ts'
import { reconcileUserStaleInboundDeliveries } from './inbound-delivery-reconciliation-authority.ts'
import { sweepStaleInboundDeliveries } from './reconcile-inbound-deliveries.ts'
import { RetryableInboundStorageError } from './service.ts'
import { createForwardableEmailMessage } from './test-fixtures.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

const appBaseUrl = 'https://kody.example.com'
const platformDomain = 'inbox.kody.example.com'

async function seedAccount(label: string) {
	const username = `${label}-${crypto.randomUUID().slice(0, 8)}`
	const email = `${username}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	await env.APP_DB.prepare(
		`INSERT INTO users (
			username, email, password_hash, email_verified_at, stable_user_id
		) VALUES (?, ?, 'hash', ?, ?)`,
	)
		.bind(username, email, new Date().toISOString(), userId)
		.run()
	return {
		address: `${username}@${platformDomain}`,
		email,
		userId,
		username,
	}
}

function inboundMessage(input: {
	address: string
	envelopeFrom?: string
	raw?: string
}) {
	return createForwardableEmailMessage({
		from: input.envelopeFrom ?? 'sender@example.net',
		to: input.address,
		raw:
			input.raw ??
			[
				'From: Sender <sender@example.net>',
				`To: ${input.address}`,
				'Subject: Authority workflow',
				`Message-ID: <authority-${crypto.randomUUID()}@example.net>`,
				'',
				'Body.',
			].join('\r\n'),
	})
}

async function readReceiveCount(userId: string) {
	const result = await userMeterRpc({ env, userId }).read({
		resource: 'email_receives_per_day',
		day: new Date().toISOString().slice(0, 10),
	})
	return result.outcome === 'ready' ? result.count : 0
}

function captureD1Sql(db: D1Database) {
	const sql: Array<string> = []
	return {
		sql,
		db: new Proxy(db, {
			get(target, property, receiver) {
				if (property === 'prepare') {
					return (statement: string) => {
						sql.push(statement)
						return target.prepare(statement)
					}
				}
				if (property === 'exec') {
					return (statement: string) => {
						sql.push(statement)
						return target.exec(statement)
					}
				}
				const value = Reflect.get(target, property, receiver)
				return typeof value === 'function' ? value.bind(target) : value
			},
		}),
	}
}

test('Mailbox delivery-window CAS serializes candidates across a bucket boundary', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = uniqueUserId('window-boundary')
	const authority = createUserInboundDeliveryAuthority({ env, userId })
	const boundary =
		Math.ceil(
			Date.parse('2026-07-20T12:00:00.000Z') / inboundDeliveryDedupeWindowMs,
		) * inboundDeliveryDedupeWindowMs
	const deliveryInput = {
		userId,
		inboxId: `inbox-${crypto.randomUUID()}`,
		recipient: 'boundary@example.com',
		envelopeFrom: 'sender@example.net',
		rawMime: 'identical boundary bytes',
		quotaDay: '2026-07-20',
	}
	const before = await buildInboundDelivery({
		...deliveryInput,
		now: new Date(boundary - 1),
	})
	const after = await buildInboundDelivery({
		...deliveryInput,
		now: new Date(boundary + 1),
	})
	expect(before.deliveryId).not.toBe(after.deliveryId)
	const [first, second] = await Promise.all([
		authority.claimWindow(before, new Date(boundary - 1)),
		authority.claimWindow(after, new Date(boundary + 1)),
	])
	expect(first.deliveryId).toBe(second.deliveryId)
}, 30_000)

test('identical MIME from distinct envelopes creates two Mailbox deliveries and charges twice', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const account = await seedAccount('distinct-envelope')
	const raw = [
		'From: Shared <shared@example.net>',
		`To: ${account.address}`,
		'Subject: Same MIME',
		'',
		'Identical payload.',
	].join('\r\n')
	const captured = captureD1Sql(env.APP_DB)
	for (const envelopeFrom of [
		'envelope-a@example.net',
		'envelope-b@example.net',
	]) {
		await handleInboundEmail(
			inboundMessage({ address: account.address, envelopeFrom, raw }),
			{ ...env, APP_DB: captured.db, APP_BASE_URL: appBaseUrl },
		)
	}
	expect(
		await mailboxRpc({ env, userId: account.userId }).listMessages({
			limit: 10,
		}),
	).toMatchObject({ messages: [{}, {}] })
	expect(await readReceiveCount(account.userId)).toBe(2)
	expect(captured.sql.join('\n')).not.toMatch(
		/\bemail_(?:threads|messages|attachments|delivery_events)\b/,
	)
}, 30_000)

test('raw MIME read failure occurs before quota and successful redelivery charges once', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const account = await seedAccount('raw-read-failure')
	const raw = 'Subject: Unreadable\r\n\r\nBody'
	const unreadable = inboundMessage({ address: account.address, raw })
	Object.defineProperty(unreadable, 'raw', {
		value: new ReadableStream({
			pull() {
				throw new Error('raw stream read failed')
			},
		}),
	})
	await expect(
		handleInboundEmail(unreadable, { ...env, APP_BASE_URL: appBaseUrl }),
	).rejects.toBeInstanceOf(RetryableInboundStorageError)
	expect(await readReceiveCount(account.userId)).toBe(0)
	const retry = inboundMessage({ address: account.address, raw })
	await handleInboundEmail(retry, { ...env, APP_BASE_URL: appBaseUrl })
	expect(await readReceiveCount(account.userId)).toBe(1)
	expect(
		await mailboxRpc({ env, userId: account.userId }).listMessages({
			limit: 10,
		}),
	).toMatchObject({ messages: [{}] })
}, 30_000)

test('Mailbox stored-count failure happens before durable quota charge', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const account = await seedAccount('stored-count-failure')
	const baseEnv = { ...env, APP_BASE_URL: appBaseUrl }
	const failingEnv = {
		...baseEnv,
		MAILBOX: {
			idFromName: (name: string) => baseEnv.MAILBOX.idFromName(name),
			get: (id: DurableObjectId) => {
				const mailbox = baseEnv.MAILBOX.get(id)
				return new Proxy(mailbox, {
					get(target, property, receiver) {
						if (property === 'countMessages') {
							return async () => {
								throw new Error('simulated stored count failure')
							}
						}
						return Reflect.get(target, property, receiver)
					},
				})
			},
		},
	} as Parameters<typeof handleInboundEmail>[1]
	await expect(
		handleInboundEmail(
			inboundMessage({ address: account.address }),
			failingEnv,
		),
	).rejects.toThrow('simulated stored count failure')
	expect(await readReceiveCount(account.userId)).toBe(0)
	expect(
		await mailboxRpc({ env, userId: account.userId }).listDeliveryEvents({
			limit: 10,
		}),
	).toEqual([])
}, 30_000)

test('Mailbox storage lease takeover fences stale finalization and cleanup', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = uniqueUserId('lease-takeover')
	const authority = createUserInboundDeliveryAuthority({ env, userId })
	const mailbox = mailboxRpc({ env, userId })
	const oldNow = new Date('2026-07-19T00:00:00.000Z')
	const takeoverNow = new Date(
		oldNow.getTime() + mailboxInboundStorageLeaseMs + 1_000,
	)
	const delivery = await buildInboundDelivery({
		userId,
		inboxId: `inbox-${crypto.randomUUID()}`,
		recipient: 'lease-race@example.com',
		envelopeFrom: 'sender@example.net',
		rawMime: 'lease race raw MIME',
		quotaDay: '2026-07-19',
		now: oldNow,
	})
	await mailbox.insertChargedPendingInboundDelivery({
		ownerId: userId,
		delivery,
		now: oldNow.toISOString(),
	})
	const pending = await authority.get(delivery.deliveryId)
	if (!pending) throw new Error('Expected pending delivery.')
	const staleClaim = await authority.claimStorage(pending, 0, undefined, oldNow)
	if (!staleClaim.claimed) throw new Error('Expected initial storage claim.')
	const takeover = await authority.claimStorage(
		staleClaim.delivery,
		0,
		staleClaim.delivery.usageStartedAt ?? undefined,
		takeoverNow,
	)
	if (!takeover.claimed) throw new Error('Expected storage lease takeover.')
	expect(takeover.delivery.storageLease).not.toBe(
		staleClaim.delivery.storageLease,
	)
	const thread = baseThread({
		id: delivery.threadId,
		inboxId: delivery.inboxId,
		createdAt: oldNow.toISOString(),
		updatedAt: oldNow.toISOString(),
		lastMessageAt: oldNow.toISOString(),
	})
	const message = baseMessage(userId, {
		id: delivery.messageId,
		inboxId: delivery.inboxId,
		threadId: delivery.threadId,
		rawMimeKey: delivery.rawMimeKey,
		createdAt: oldNow.toISOString(),
		updatedAt: oldNow.toISOString(),
		receivedAt: oldNow.toISOString(),
	})
	await expect(
		authority.commitInboundMessageGraph({
			delivery: staleClaim.delivery,
			thread,
			message,
			attachments: [],
		}),
	).resolves.toEqual({ status: 'lease-lost' })
	await expect(
		authority.receive({
			delivery: staleClaim.delivery,
			usageDurationMs: 1,
			usageMonth: '2026-07',
			usageBytes: 19,
			now: takeoverNow,
		}),
	).rejects.toBeInstanceOf(InboundDeliveryLeaseLostError)
	await env.EMAIL_BLOBS.put(delivery.rawMimeKey, 'lease race raw MIME')
	await expect(
		reconcileUserStaleInboundDeliveries({
			env,
			userId,
			now: takeoverNow,
		}),
	).resolves.toEqual({ recovered: 0, cleaned: 0 })
	expect(await env.EMAIL_BLOBS.get(delivery.rawMimeKey)).not.toBeNull()
}, 30_000)

test('scheduled due-owner sweep recovers a committed Mailbox graph without shared D1 graph access', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const account = await seedAccount('scheduled-recovery')
	const oldNow = new Date('2026-07-30T00:00:00.000Z')
	const sweepNow = new Date('2026-08-03T00:00:00.000Z')
	const delivery = await buildInboundDelivery({
		userId: account.userId,
		inboxId: `inbox-${crypto.randomUUID()}`,
		recipient: account.address,
		envelopeFrom: 'sender@example.net',
		rawMime: 'partially committed raw MIME',
		quotaDay: '2026-07-30',
		now: oldNow,
	})
	const mailbox = mailboxRpc({ env, userId: account.userId })
	await mailbox.insertChargedPendingInboundDelivery({
		ownerId: account.userId,
		delivery,
		now: oldNow.toISOString(),
	})
	const authority = createUserInboundDeliveryAuthority({
		env,
		userId: account.userId,
	})
	const pending = await authority.get(delivery.deliveryId)
	if (!pending) throw new Error('Expected pending delivery.')
	const claim = await authority.claimStorage(pending, 0, undefined, oldNow)
	if (!claim.claimed) throw new Error('Expected storage claim.')
	const thread = baseThread({
		id: delivery.threadId,
		inboxId: delivery.inboxId,
		createdAt: oldNow.toISOString(),
		updatedAt: oldNow.toISOString(),
		lastMessageAt: oldNow.toISOString(),
	})
	const message = baseMessage(account.userId, {
		id: delivery.messageId,
		inboxId: delivery.inboxId,
		threadId: thread.id,
		rawMimeKey: delivery.rawMimeKey,
		rawSize: 28,
		receivedAt: oldNow.toISOString(),
		createdAt: oldNow.toISOString(),
		updatedAt: oldNow.toISOString(),
	})
	await env.EMAIL_BLOBS.put(delivery.rawMimeKey, 'partially committed raw MIME')
	await expect(
		authority.commitInboundMessageGraph({
			delivery: claim.delivery,
			thread,
			message,
			attachments: [],
		}),
	).resolves.toMatchObject({ status: 'committed' })
	await replaceInboundDueOwnerHint({
		db: env.APP_DB,
		userId: account.userId,
		dueAt: oldNow.toISOString(),
		reason: 'test-partial-commit',
		now: sweepNow,
	})
	const captured = captureD1Sql(env.APP_DB)
	await expect(
		sweepStaleInboundDeliveries({
			env: { ...env, APP_DB: captured.db, APP_BASE_URL: appBaseUrl },
			now: sweepNow,
		}),
	).resolves.toMatchObject({ recovered: 1, cleaned: 0, errors: 0 })
	await expect(authority.get(delivery.deliveryId)).resolves.toMatchObject({
		state: 'received',
	})
	expect(captured.sql.join('\n')).not.toMatch(
		/\bemail_(?:threads|messages|attachments|delivery_events)\b/,
	)
}, 30_000)
