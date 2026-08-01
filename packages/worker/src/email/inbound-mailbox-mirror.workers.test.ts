import { env } from 'cloudflare:workers'
import { expect, test, vi } from 'vitest'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'
import { buildInboundDelivery } from './inbound-delivery.ts'
import { handleInboundEmail } from './inbound.ts'
import { mailboxMirrorRpcTimeoutMs } from './mailbox-mirror.ts'
import { rpcFor } from './mailbox-test-helpers.ts'
import * as parser from './parser.ts'
import { listEmailMessages } from './repo.ts'
import { RetryableInboundStorageError } from './service.ts'
import { createForwardableEmailMessage } from './test-fixtures.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

const platformBaseUrl = 'https://kody.example.com'
const platformDomain = 'inbox.kody.example.com'

function createInboundEnv() {
	return { ...env, APP_BASE_URL: platformBaseUrl }
}

async function seedAccount(input: {
	db: D1Database
	email: string
	username: string
	emailVerifiedAt?: string | null
}) {
	const stableUserId = await createStableUserIdFromEmail(input.email)
	await input.db
		.prepare(
			`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id, plan)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(email) DO UPDATE SET
			   username = excluded.username,
			   email_verified_at = excluded.email_verified_at,
			   stable_user_id = COALESCE(users.stable_user_id, excluded.stable_user_id),
			   plan = excluded.plan,
			   updated_at = CURRENT_TIMESTAMP`,
		)
		.bind(
			input.username,
			input.email,
			'test-password-hash',
			input.emailVerifiedAt === undefined
				? new Date().toISOString()
				: input.emailVerifiedAt,
			stableUserId,
			'max',
		)
		.run()
}

async function seedVerifiedAccount(input: {
	db: D1Database
	email: string
	username: string
}) {
	await seedAccount(input)
}

async function readUserDailyReceiveCount(userId: string) {
	const result = await userMeterRpc({ env, userId }).read({
		resource: 'email_receives_per_day',
		day: new Date().toISOString().slice(0, 10),
	})
	return result.outcome === 'ready' ? result.count : 0
}

function createFailingEmailBlobs() {
	return new Proxy(env.EMAIL_BLOBS, {
		get(target, property, receiver) {
			if (property === 'put') {
				return async () => {
					throw new Error('simulated R2 outage')
				}
			}
			const value = Reflect.get(target, property, receiver)
			return typeof value === 'function' ? value.bind(target) : value
		},
	})
}

const inboundMailboxMirrorTimeoutMs = 30_000

/** MAILBOX stub that fails or hangs every mirror RPC without touching the real DO. */
function createInboundMailboxStubEnv(input: {
	mode: 'throw' | 'hang'
	base?: typeof env
}) {
	const base = input.base ?? env
	const hang = () => new Promise<never>(() => {})
	const fail = async () => {
		throw new Error('simulated mailbox failure')
	}
	const method = input.mode === 'hang' ? hang : fail
	const stub = {
		mirrorMessage: method,
		upsertDeliveryEvent: method,
		upsertDeliveryEvents: method,
		touchThread: method,
		updateMessageDelivery: method,
		setMessageClassification: method,
		deleteMessageMetadata: method,
		deleteDeliveryEvent: method,
		deleteThreadIfEmpty: method,
	}
	return {
		...base,
		APP_BASE_URL: platformBaseUrl,
		MAILBOX: {
			idFromName: (name: string) => base.MAILBOX.idFromName(name),
			get: () => stub,
		} as unknown as DurableObjectNamespace,
	}
}

function buildInboundAttachmentRaw(input: {
	address: string
	subject: string
	messageIdHeader: string
	body: string
	attachmentText: string
}) {
	return [
		'From: Sender <sender@example.net>',
		`To: ${input.address}`,
		`Subject: ${input.subject}`,
		`Message-ID: <${input.messageIdHeader}>`,
		'Content-Type: multipart/mixed; boundary="mail-boundary"',
		'',
		'--mail-boundary',
		'Content-Type: text/plain; charset="utf-8"',
		'',
		input.body,
		'--mail-boundary',
		'Content-Type: text/plain; name="note.txt"',
		'Content-Disposition: attachment; filename="note.txt"',
		'',
		input.attachmentText,
		'--mail-boundary--',
	].join('\r\n')
}

test(
	'inbound finalization mirrors message, thread, attachments, and received event into Mailbox',
	async () => {
		silenceIncidentalRuntimeWarnings()
		await ensureEmailTestSchema(env.APP_DB)
		await ensureUsageRollupsTestSchema(env.APP_DB)
		const username = `mbx-in-${crypto.randomUUID().slice(0, 8)}`
		const accountEmail = `mbx-in-${crypto.randomUUID()}@example.com`
		const userId = await createStableUserIdFromEmail(accountEmail)
		const address = `${username}@${platformDomain}`
		await seedVerifiedAccount({
			db: env.APP_DB,
			email: accountEmail,
			username,
		})
		const mailbox = rpcFor(userId)
		await mailbox.getMessage({ messageId: 'warmup-nonexistent' })

		const raw = buildInboundAttachmentRaw({
			address,
			subject: 'Mailbox inbound mirror',
			messageIdHeader: 'mailbox-inbound@example.net',
			body: 'Mirrored inbound body.',
			attachmentText: 'Attachment bytes',
		})
		const message = createForwardableEmailMessage({
			from: 'sender@example.net',
			to: address,
			raw,
		})
		await handleInboundEmail(message, createInboundEnv())
		expect(message.rejectedReason).toBeNull()

		const [stored] = await listEmailMessages({
			db: env.APP_DB,
			userId,
			limit: 1,
		})
		expect(stored).toBeDefined()
		if (!stored) throw new Error('Expected stored inbound message')
		expect(stored.threadId).toBeTruthy()

		const mirroredMessage = await mailbox.getMessage({
			messageId: stored.id,
		})
		expect(mirroredMessage).toMatchObject({
			id: stored.id,
			direction: 'inbound',
			processingStatus: 'stored',
			subject: 'Mailbox inbound mirror',
			threadId: stored.threadId,
		})
		expect(
			await mailbox.getThread({ threadId: stored.threadId! }),
		).toMatchObject({
			id: stored.threadId,
			subjectNormalized: 'mailbox inbound mirror',
		})
		expect(
			await mailbox.listAttachmentsForMessage({ messageId: stored.id }),
		).toEqual([
			expect.objectContaining({
				filename: 'note.txt',
				contentType: 'text/plain',
				storageKind: 'raw-mime',
			}),
		])
		const mirroredEvents = await mailbox.listDeliveryEvents({
			messageId: stored.id,
			limit: 10,
		})
		expect(mirroredEvents.map((event) => event.eventType)).toEqual(['received'])
		expect(mirroredEvents[0]).toMatchObject({
			id: expect.stringMatching(/^email-inbound-delivery:/),
			provider: 'cloudflare-email-routing',
		})
		expect(await readUserDailyReceiveCount(userId)).toBe(1)
	},
	inboundMailboxMirrorTimeoutMs,
)

test(
	'Email Routing retry creates one message and charge with idempotent Mailbox mirror',
	async () => {
		silenceIncidentalRuntimeWarnings()
		await ensureEmailTestSchema(env.APP_DB)
		const username = `mbx-retry-${crypto.randomUUID().slice(0, 8)}`
		const accountEmail = `mbx-retry-${crypto.randomUUID()}@example.com`
		const userId = await createStableUserIdFromEmail(accountEmail)
		const address = `${username}@${platformDomain}`
		await seedVerifiedAccount({
			db: env.APP_DB,
			email: accountEmail,
			username,
		})
		const mailbox = rpcFor(userId)
		await mailbox.getMessage({ messageId: 'warmup-nonexistent' })

		const raw = buildInboundAttachmentRaw({
			address,
			subject: 'Idempotent inbound mirror',
			messageIdHeader: 'mailbox-idempotent@example.net',
			body: 'Same bytes twice.',
			attachmentText: 'Same attachment',
		})
		const first = createForwardableEmailMessage({
			from: 'sender@example.net',
			to: address,
			raw,
		})
		const second = createForwardableEmailMessage({
			from: 'sender@example.net',
			to: address,
			raw,
		})
		await handleInboundEmail(first, createInboundEnv())
		await handleInboundEmail(second, createInboundEnv())
		expect(first.rejectedReason).toBeNull()
		expect(second.rejectedReason).toBeNull()

		const messages = await listEmailMessages({
			db: env.APP_DB,
			userId,
			limit: 10,
		})
		expect(messages).toHaveLength(1)
		expect(await readUserDailyReceiveCount(userId)).toBe(1)

		const mirroredEvents = await mailbox.listDeliveryEvents({
			messageId: messages[0]!.id,
			limit: 10,
		})
		expect(mirroredEvents).toHaveLength(1)
		expect(mirroredEvents[0]?.eventType).toBe('received')
		expect(
			await mailbox.getMessage({ messageId: messages[0]!.id }),
		).toMatchObject({
			id: messages[0]!.id,
			direction: 'inbound',
		})
	},
	inboundMailboxMirrorTimeoutMs,
)

test(
	'pre-commit inbound failure retries without Mailbox message and preserves one charge',
	async () => {
		silenceIncidentalRuntimeWarnings()
		await ensureEmailTestSchema(env.APP_DB)
		const username = `mbx-pre-${crypto.randomUUID().slice(0, 8)}`
		const accountEmail = `mbx-pre-${crypto.randomUUID()}@example.com`
		const userId = await createStableUserIdFromEmail(accountEmail)
		const address = `${username}@${platformDomain}`
		await seedVerifiedAccount({
			db: env.APP_DB,
			email: accountEmail,
			username,
		})
		const mailbox = rpcFor(userId)
		await mailbox.getMessage({ messageId: 'warmup-nonexistent' })

		const raw = [
			'From: Sender <sender@example.net>',
			`To: ${address}`,
			'Subject: Pre-commit mailbox guard',
			'Message-ID: <mailbox-precommit@example.net>',
			'',
			'Should not mirror.',
		].join('\r\n')
		const failingEnv = {
			...createInboundEnv(),
			EMAIL_BLOBS: createFailingEmailBlobs(),
		} as Parameters<typeof handleInboundEmail>[1]

		const first = createForwardableEmailMessage({
			from: 'sender@example.net',
			to: address,
			raw,
		})
		await expect(handleInboundEmail(first, failingEnv)).rejects.toBeInstanceOf(
			RetryableInboundStorageError,
		)
		expect(first.rejectedReason).toBeNull()
		expect(await readUserDailyReceiveCount(userId)).toBe(1)
		expect(
			await listEmailMessages({ db: env.APP_DB, userId, limit: 10 }),
		).toEqual([])

		const candidate = await buildInboundDelivery({
			userId,
			inboxId: 'unused',
			recipient: address,
			envelopeFrom: 'sender@example.net',
			rawMime: raw,
			quotaDay: new Date().toISOString().slice(0, 10),
		})
		expect(
			await mailbox.getMessage({ messageId: candidate.messageId }),
		).toBeNull()

		const retry = createForwardableEmailMessage({
			from: 'sender@example.net',
			to: address,
			raw,
		})
		await handleInboundEmail(retry, createInboundEnv())
		expect(retry.rejectedReason).toBeNull()
		expect(await readUserDailyReceiveCount(userId)).toBe(1)
		const [stored] = await listEmailMessages({
			db: env.APP_DB,
			userId,
			limit: 1,
		})
		expect(stored?.id).toBe(candidate.messageId)
		expect(
			await mailbox.getMessage({ messageId: candidate.messageId }),
		).toMatchObject({
			id: candidate.messageId,
			direction: 'inbound',
		})
	},
	inboundMailboxMirrorTimeoutMs,
)

test(
	'inbound Mailbox mirror timeout and error are acknowledged without throw or reject',
	async () => {
		silenceIncidentalRuntimeWarnings([
			'mailbox-mirror-message-failed',
			'mailbox-mirror-delivery-event-failed',
			'mailbox-mirror-delivery-event-batch-failed',
			'mailbox-live-mirror-message-graph-failed',
			'mailbox-live-mirror-delivery-event-failed',
		])
		await ensureEmailTestSchema(env.APP_DB)

		{
			const username = `mbx-err-${crypto.randomUUID().slice(0, 8)}`
			const accountEmail = `mbx-err-${crypto.randomUUID()}@example.com`
			const userId = await createStableUserIdFromEmail(accountEmail)
			const address = `${username}@${platformDomain}`
			await seedVerifiedAccount({
				db: env.APP_DB,
				email: accountEmail,
				username,
			})
			const raw = [
				'From: Sender <sender@example.net>',
				`To: ${address}`,
				'Subject: Mailbox throw ignored',
				'Message-ID: <mailbox-throw@example.net>',
				'',
				'Body',
			].join('\r\n')
			const message = createForwardableEmailMessage({
				from: 'sender@example.net',
				to: address,
				raw,
			})
			await handleInboundEmail(
				message,
				createInboundMailboxStubEnv({ mode: 'throw' }),
			)
			expect(message.rejectedReason).toBeNull()
			expect(await readUserDailyReceiveCount(userId)).toBe(1)
			expect(
				await listEmailMessages({ db: env.APP_DB, userId, limit: 1 }),
			).toHaveLength(1)
		}

		{
			const username = `mbx-hang-${crypto.randomUUID().slice(0, 8)}`
			const accountEmail = `mbx-hang-${crypto.randomUUID()}@example.com`
			const userId = await createStableUserIdFromEmail(accountEmail)
			const address = `${username}@${platformDomain}`
			await seedVerifiedAccount({
				db: env.APP_DB,
				email: accountEmail,
				username,
			})
			const raw = [
				'From: Sender <sender@example.net>',
				`To: ${address}`,
				'Subject: Mailbox hang ignored',
				'Message-ID: <mailbox-hang@example.net>',
				'',
				'Body',
			].join('\r\n')
			const message = createForwardableEmailMessage({
				from: 'sender@example.net',
				to: address,
				raw,
			})
			const startedAt = Date.now()
			await handleInboundEmail(
				message,
				createInboundMailboxStubEnv({ mode: 'hang' }),
			)
			const elapsedMs = Date.now() - startedAt
			expect(message.rejectedReason).toBeNull()
			expect(await readUserDailyReceiveCount(userId)).toBe(1)
			expect(
				await listEmailMessages({ db: env.APP_DB, userId, limit: 1 }),
			).toHaveLength(1)
			// Graph + post-effects event each race the mirror RPC bound.
			expect(elapsedMs).toBeLessThan(mailboxMirrorRpcTimeoutMs * 8)
		}
	},
	inboundMailboxMirrorTimeoutMs,
)

test(
	'already-received inbound replay repairs Mailbox graph without a second charge',
	async () => {
		silenceIncidentalRuntimeWarnings([
			'mailbox-mirror-message-failed',
			'mailbox-mirror-delivery-event-failed',
			'mailbox-mirror-delivery-event-batch-failed',
			'mailbox-live-mirror-message-graph-failed',
			'mailbox-live-mirror-delivery-event-failed',
		])
		await ensureEmailTestSchema(env.APP_DB)
		const username = `mbx-replay-${crypto.randomUUID().slice(0, 8)}`
		const accountEmail = `mbx-replay-${crypto.randomUUID()}@example.com`
		const userId = await createStableUserIdFromEmail(accountEmail)
		const address = `${username}@${platformDomain}`
		await seedVerifiedAccount({
			db: env.APP_DB,
			email: accountEmail,
			username,
		})
		const mailbox = rpcFor(userId)
		await mailbox.getMessage({ messageId: 'warmup-nonexistent' })

		const raw = buildInboundAttachmentRaw({
			address,
			subject: 'Replay repair',
			messageIdHeader: 'mailbox-replay@example.net',
			body: 'Stored before repair.',
			attachmentText: 'Repair me',
		})
		const first = createForwardableEmailMessage({
			from: 'sender@example.net',
			to: address,
			raw,
		})
		await handleInboundEmail(
			first,
			createInboundMailboxStubEnv({ mode: 'throw' }),
		)
		expect(first.rejectedReason).toBeNull()
		const [stored] = await listEmailMessages({
			db: env.APP_DB,
			userId,
			limit: 1,
		})
		expect(stored).toBeDefined()
		if (!stored) throw new Error('Expected stored inbound message')
		expect(await mailbox.getMessage({ messageId: stored.id })).toBeNull()
		expect(await readUserDailyReceiveCount(userId)).toBe(1)

		const replay = createForwardableEmailMessage({
			from: 'sender@example.net',
			to: address,
			raw,
		})
		await handleInboundEmail(replay, createInboundEnv())
		expect(replay.rejectedReason).toBeNull()
		expect(await readUserDailyReceiveCount(userId)).toBe(1)
		expect(
			await listEmailMessages({ db: env.APP_DB, userId, limit: 10 }),
		).toHaveLength(1)

		expect(await mailbox.getMessage({ messageId: stored.id })).toMatchObject({
			id: stored.id,
			direction: 'inbound',
			subject: 'Replay repair',
			threadId: stored.threadId,
		})
		expect(
			await mailbox.listAttachmentsForMessage({ messageId: stored.id }),
		).toEqual([
			expect.objectContaining({
				filename: 'note.txt',
				storageKind: 'raw-mime',
			}),
		])
		expect(
			(
				await mailbox.listDeliveryEvents({ messageId: stored.id, limit: 10 })
			).map((event) => event.eventType),
		).toEqual(['received'])
	},
	inboundMailboxMirrorTimeoutMs,
)

test(
	'terminal inbound rejection mirrors the delivery event into Mailbox',
	async () => {
		silenceIncidentalRuntimeWarnings()
		await ensureEmailTestSchema(env.APP_DB)
		const username = `mbx-rej-${crypto.randomUUID().slice(0, 8)}`
		const accountEmail = `mbx-rej-${crypto.randomUUID()}@example.com`
		const userId = await createStableUserIdFromEmail(accountEmail)
		const address = `${username}@${platformDomain}`
		await seedVerifiedAccount({
			db: env.APP_DB,
			email: accountEmail,
			username,
		})
		const mailbox = rpcFor(userId)
		await mailbox.getMessage({ messageId: 'warmup-nonexistent' })

		const raw = [
			'From: Sender <sender@example.net>',
			`To: ${address}`,
			'Subject: Parse reject mirror',
			'Message-ID: <mailbox-reject@example.net>',
			'',
			'Body',
		].join('\r\n')
		const parseSpy = vi
			.spyOn(parser, 'parseForwardableEmailRawMime')
			.mockRejectedValueOnce(new Error('simulated parse failure'))
		try {
			const message = createForwardableEmailMessage({
				from: 'sender@example.net',
				to: address,
				raw,
			})
			await handleInboundEmail(message, createInboundEnv())
			expect(message.rejectedReason).toBe('simulated parse failure')
			expect(await readUserDailyReceiveCount(userId)).toBe(1)
			expect(
				await listEmailMessages({ db: env.APP_DB, userId, limit: 10 }),
			).toEqual([])

			const delivery = await env.APP_DB.prepare(
				`SELECT id, event_type FROM email_delivery_events
				WHERE user_id = ? AND provider = 'cloudflare-email-routing'
					AND event_type = 'rejected'`,
			)
				.bind(userId)
				.first<{ id: string; event_type: string }>()
			expect(delivery?.event_type).toBe('rejected')
			if (!delivery) throw new Error('Expected rejected delivery ledger.')

			const mirrored = await mailbox.listDeliveryEvents({
				messageId: null,
				limit: 20,
			})
			const rejectedEvent = mirrored.find((event) => event.id === delivery.id)
			expect(rejectedEvent).toMatchObject({
				id: delivery.id,
				eventType: 'rejected',
				provider: 'cloudflare-email-routing',
				messageId: null,
			})

			// Claimed-rejected replay re-mirrors the same event idempotently.
			const replay = createForwardableEmailMessage({
				from: 'sender@example.net',
				to: address,
				raw,
			})
			await handleInboundEmail(replay, createInboundEnv())
			expect(replay.rejectedReason).toBe('simulated parse failure')
			const afterReplay = await mailbox.listDeliveryEvents({
				messageId: null,
				limit: 20,
			})
			expect(
				afterReplay.filter((event) => event.id === delivery.id),
			).toHaveLength(1)
			expect(await readUserDailyReceiveCount(userId)).toBe(1)
		} finally {
			parseSpy.mockRestore()
		}
	},
	inboundMailboxMirrorTimeoutMs,
)
