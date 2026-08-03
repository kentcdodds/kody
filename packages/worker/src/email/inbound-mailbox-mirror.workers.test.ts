import { env } from 'cloudflare:workers'
import { expect, test, vi } from 'vitest'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
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

function createCapturedWaitUntilContext() {
	const waitUntilPromises: Array<Promise<unknown>> = []
	const ctx = {
		waitUntil(promise: Promise<unknown>) {
			waitUntilPromises.push(promise)
		},
		passThroughOnException() {},
	} as ExecutionContext
	return { ctx, waitUntilPromises }
}

async function drainWaitUntil(waitUntilPromises: Array<Promise<unknown>>) {
	for (let index = 0; index < waitUntilPromises.length; index += 1) {
		await waitUntilPromises[index]
	}
}

async function seedVerifiedAccount(input: {
	db: D1Database
	email: string
	username: string
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
			new Date().toISOString(),
			stableUserId,
			'max',
		)
		.run()
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

function createRejectProjectionFailingDb(db: D1Database) {
	let failed = false
	const failingDb = new Proxy(db, {
		get(target, property) {
			if (property === 'prepare') {
				return (query: string) => {
					const statement = target.prepare(query)
					if (!query.includes('INSERT INTO email_delivery_events')) {
						return statement
					}
					return new Proxy(statement, {
						get(statementTarget, statementProperty) {
							if (statementProperty === 'bind') {
								return (...values: Array<unknown>) => {
									const bound = statementTarget.bind(...values)
									if (failed || values[4] !== 'rejected') return bound
									return new Proxy(bound, {
										get(boundTarget, boundProperty) {
											if (boundProperty === 'run') {
												return async () => {
													failed = true
													throw new Error(
														'simulated rejected projection failure',
													)
												}
											}
											const value = Reflect.get(boundTarget, boundProperty)
											return typeof value === 'function'
												? value.bind(boundTarget)
												: value
										},
									})
								}
							}
							const value = Reflect.get(statementTarget, statementProperty)
							return typeof value === 'function'
								? value.bind(statementTarget)
								: value
						},
					})
				}
			}
			const value = Reflect.get(target, property)
			return typeof value === 'function' ? value.bind(target) : value
		},
	})
	return { db: failingDb, didFail: () => failed }
}

const inboundMailboxMirrorTimeoutMs = 30_000

function createLedgerBackedMailboxStub(
	mailbox: ReturnType<typeof env.MAILBOX.get>,
) {
	return {
		async countMessages(...args: Parameters<typeof mailbox.countMessages>) {
			return await mailbox.countMessages(...args)
		},
		async getMessage(...args: Parameters<typeof mailbox.getMessage>) {
			return await mailbox.getMessage(...args)
		},
		async listAttachmentsForMessage(
			...args: Parameters<typeof mailbox.listAttachmentsForMessage>
		) {
			return await mailbox.listAttachmentsForMessage(...args)
		},
		async getInboundDelivery(
			...args: Parameters<typeof mailbox.getInboundDelivery>
		) {
			return await mailbox.getInboundDelivery(...args)
		},
		async getInboundDeliveryWindow(
			...args: Parameters<typeof mailbox.getInboundDeliveryWindow>
		) {
			return await mailbox.getInboundDeliveryWindow(...args)
		},
		async claimInboundDeliveryWindow(
			...args: Parameters<typeof mailbox.claimInboundDeliveryWindow>
		) {
			return await mailbox.claimInboundDeliveryWindow(...args)
		},
		async insertChargedPendingInboundDelivery(
			...args: Parameters<typeof mailbox.insertChargedPendingInboundDelivery>
		) {
			return await mailbox.insertChargedPendingInboundDelivery(...args)
		},
		async claimInboundDeliveryStorage(
			...args: Parameters<typeof mailbox.claimInboundDeliveryStorage>
		) {
			return await mailbox.claimInboundDeliveryStorage(...args)
		},
		async releaseInboundDeliveryStorage(
			...args: Parameters<typeof mailbox.releaseInboundDeliveryStorage>
		) {
			return await mailbox.releaseInboundDeliveryStorage(...args)
		},
		async markInboundDeliveryRejected(
			...args: Parameters<typeof mailbox.markInboundDeliveryRejected>
		) {
			return await mailbox.markInboundDeliveryRejected(...args)
		},
		async markInboundDeliveryReceived(
			...args: Parameters<typeof mailbox.markInboundDeliveryReceived>
		) {
			return await mailbox.markInboundDeliveryReceived(...args)
		},
		async pruneExpiredInboundDedupePointers(
			...args: Parameters<typeof mailbox.pruneExpiredInboundDedupePointers>
		) {
			return await mailbox.pruneExpiredInboundDedupePointers(...args)
		},
		async listDueStaleInboundDeliveries(
			...args: Parameters<typeof mailbox.listDueStaleInboundDeliveries>
		) {
			return await mailbox.listDueStaleInboundDeliveries(...args)
		},
		async claimInboundUsageEffect(
			...args: Parameters<typeof mailbox.claimInboundUsageEffect>
		) {
			return await mailbox.claimInboundUsageEffect(...args)
		},
		async completeInboundUsageEffect(
			...args: Parameters<typeof mailbox.completeInboundUsageEffect>
		) {
			return await mailbox.completeInboundUsageEffect(...args)
		},
		async claimInboundSubscriptionEffect(
			...args: Parameters<typeof mailbox.claimInboundSubscriptionEffect>
		) {
			return await mailbox.claimInboundSubscriptionEffect(...args)
		},
		async completeInboundSubscriptionEffect(
			...args: Parameters<typeof mailbox.completeInboundSubscriptionEffect>
		) {
			return await mailbox.completeInboundSubscriptionEffect(...args)
		},
		async failInboundSubscriptionEffect(
			...args: Parameters<typeof mailbox.failInboundSubscriptionEffect>
		) {
			return await mailbox.failInboundSubscriptionEffect(...args)
		},
	}
}

/** MAILBOX namespace that fails graph-mirror RPCs but keeps ledger CAS real. */
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
	return {
		...base,
		APP_BASE_URL: platformBaseUrl,
		MAILBOX: {
			idFromName: (name: string) => base.MAILBOX.idFromName(name),
			get: (id: DurableObjectId) => {
				const mailbox = base.MAILBOX.get(id)
				return {
					...createLedgerBackedMailboxStub(mailbox),
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
			},
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
		const { ctx, waitUntilPromises } = createCapturedWaitUntilContext()

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
		await handleInboundEmail(message, createInboundEnv(), ctx)
		expect(message.rejectedReason).toBeNull()
		await drainWaitUntil(waitUntilPromises)

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
		expect(mirroredEvents[0]?.usageEffectRecordedAt).toEqual(expect.any(String))
		expect(await readUserDailyReceiveCount(userId)).toBe(1)
	},
	inboundMailboxMirrorTimeoutMs,
)

test(
	'delayed graph RPCs cannot overwrite post-effects delivery event fields',
	async () => {
		silenceIncidentalRuntimeWarnings()
		await ensureEmailTestSchema(env.APP_DB)
		await ensureUsageRollupsTestSchema(env.APP_DB)
		const username = `mbx-ord-${crypto.randomUUID().slice(0, 8)}`
		const accountEmail = `mbx-ord-${crypto.randomUUID()}@example.com`
		const userId = await createStableUserIdFromEmail(accountEmail)
		const address = `${username}@${platformDomain}`
		await seedVerifiedAccount({
			db: env.APP_DB,
			email: accountEmail,
			username,
		})

		const real = rpcFor(userId)
		await real.getMessage({ messageId: 'warmup-nonexistent' })
		let releaseGraph!: () => void
		const graphGate = new Promise<void>((resolve) => {
			releaseGraph = resolve
		})
		const order: Array<string> = []
		const delayedStub = {
			...createLedgerBackedMailboxStub(real),
			async mirrorMessage(...args: Parameters<typeof real.mirrorMessage>) {
				order.push('graph-message')
				await graphGate
				return await real.mirrorMessage(...args)
			},
		}

		const orderedEnv = {
			...createInboundEnv(),
			MAILBOX: {
				idFromName: (name: string) => env.MAILBOX.idFromName(name),
				get: () => delayedStub,
			} as unknown as DurableObjectNamespace,
		}
		const { ctx, waitUntilPromises } = createCapturedWaitUntilContext()
		const raw = [
			'From: Sender <sender@example.net>',
			`To: ${address}`,
			'Subject: Ordered terminal mirror',
			'Message-ID: <mailbox-ordered@example.net>',
			'',
			'Order body',
		].join('\r\n')
		const message = createForwardableEmailMessage({
			from: 'sender@example.net',
			to: address,
			raw,
		})

		await handleInboundEmail(message, orderedEnv, ctx)
		expect(message.rejectedReason).toBeNull()
		expect(waitUntilPromises.length).toBeGreaterThanOrEqual(1)

		// Wait until the waitUntil task reaches the gated graph RPC.
		const graphStartedAt = Date.now()
		while (!order.includes('graph-message')) {
			if (Date.now() - graphStartedAt > 5_000) {
				throw new Error('Timed out waiting for gated graph mirror RPC')
			}
			await new Promise((resolve) => setTimeout(resolve, 10))
		}
		expect(order).toEqual(['graph-message'])
		expect(order.includes('post-effects-event')).toBe(false)
		const [stored] = await listEmailMessages({
			db: env.APP_DB,
			userId,
			limit: 1,
		})
		expect(stored).toBeDefined()
		if (!stored) throw new Error('Expected stored inbound message')
		const preEffectsLedger = await env.APP_DB.prepare(
			`SELECT detail_json FROM email_delivery_events
			WHERE user_id = ? AND id LIKE 'email-inbound-delivery:%'
				AND event_type = 'received'`,
		)
			.bind(userId)
			.first<{ detail_json: string }>()
		expect(
			JSON.parse(preEffectsLedger!.detail_json).usageEffectRecordedAt ?? null,
		).toBeNull()

		releaseGraph()
		await drainWaitUntil(waitUntilPromises)

		expect(order).toEqual(['graph-message'])

		const mailbox = rpcFor(userId)
		const mirroredEvents = await mailbox.listDeliveryEvents({
			messageId: stored.id,
			limit: 10,
		})
		expect(mirroredEvents).toHaveLength(1)
		expect(mirroredEvents[0]?.usageEffectRecordedAt).toEqual(expect.any(String))
		expect(mirroredEvents[0]?.subscriptionEffectState).toBe('complete')
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
		const firstCtx = createCapturedWaitUntilContext()
		const secondCtx = createCapturedWaitUntilContext()
		await handleInboundEmail(first, createInboundEnv(), firstCtx.ctx)
		await drainWaitUntil(firstCtx.waitUntilPromises)
		await handleInboundEmail(second, createInboundEnv(), secondCtx.ctx)
		await drainWaitUntil(secondCtx.waitUntilPromises)
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
		const failCtx = createCapturedWaitUntilContext()

		const first = createForwardableEmailMessage({
			from: 'sender@example.net',
			to: address,
			raw,
		})
		await expect(
			handleInboundEmail(first, failingEnv, failCtx.ctx),
		).rejects.toBeInstanceOf(RetryableInboundStorageError)
		expect(first.rejectedReason).toBeNull()
		// The charged Mailbox delivery survives this retryable graph-storage
		// failure; no terminal work should have produced a message below.
		await drainWaitUntil(failCtx.waitUntilPromises)
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

		const retryCtx = createCapturedWaitUntilContext()
		const retry = createForwardableEmailMessage({
			from: 'sender@example.net',
			to: address,
			raw,
		})
		await handleInboundEmail(retry, createInboundEnv(), retryCtx.ctx)
		await drainWaitUntil(retryCtx.waitUntilPromises)
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
		await ensureUsageRollupsTestSchema(env.APP_DB)

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
			const { ctx, waitUntilPromises } = createCapturedWaitUntilContext()
			await handleInboundEmail(
				message,
				createInboundMailboxStubEnv({ mode: 'throw' }),
				ctx,
			)
			expect(message.rejectedReason).toBeNull()
			await drainWaitUntil(waitUntilPromises)
			expect(await readUserDailyReceiveCount(userId)).toBe(1)
			expect(
				await listEmailMessages({ db: env.APP_DB, userId, limit: 1 }),
			).toHaveLength(1)
			const ledger = await env.APP_DB.prepare(
				`SELECT json_extract(detail_json, '$.usageEffectRecordedAt') AS recorded
				FROM email_delivery_events
				WHERE user_id = ? AND event_type = 'received'`,
			)
				.bind(userId)
				.first<{ recorded: string | null }>()
			// Graph failure/timeout must not skip D1 effects.
			expect(ledger?.recorded).toEqual(expect.any(String))
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
			const { ctx, waitUntilPromises } = createCapturedWaitUntilContext()
			const startedAt = Date.now()
			await handleInboundEmail(
				message,
				createInboundMailboxStubEnv({ mode: 'hang' }),
				ctx,
			)
			// Returning while the captured background work is still pending proves
			// the handler does not await the hanging mirror. Avoid a wall-clock
			// assertion here because loaded Workers CI can pause the isolate.
			expect(waitUntilPromises).not.toHaveLength(0)
			expect(message.rejectedReason).toBeNull()
			await drainWaitUntil(waitUntilPromises)
			const elapsedMs = Date.now() - startedAt
			expect(await readUserDailyReceiveCount(userId)).toBe(1)
			expect(
				await listEmailMessages({ db: env.APP_DB, userId, limit: 1 }),
			).toHaveLength(1)
			expect(elapsedMs).toBeLessThan(mailboxMirrorRpcTimeoutMs * 16)
			const ledger = await env.APP_DB.prepare(
				`SELECT json_extract(detail_json, '$.usageEffectRecordedAt') AS recorded
				FROM email_delivery_events
				WHERE user_id = ? AND event_type = 'received'`,
			)
				.bind(userId)
				.first<{ recorded: string | null }>()
			expect(ledger?.recorded).toEqual(expect.any(String))
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
		await ensureUsageRollupsTestSchema(env.APP_DB)
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
		const firstCtx = createCapturedWaitUntilContext()
		const first = createForwardableEmailMessage({
			from: 'sender@example.net',
			to: address,
			raw,
		})
		await handleInboundEmail(
			first,
			createInboundMailboxStubEnv({ mode: 'throw' }),
			firstCtx.ctx,
		)
		await drainWaitUntil(firstCtx.waitUntilPromises)
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

		const replayCtx = createCapturedWaitUntilContext()
		const replay = createForwardableEmailMessage({
			from: 'sender@example.net',
			to: address,
			raw,
		})
		await handleInboundEmail(replay, createInboundEnv(), replayCtx.ctx)
		await drainWaitUntil(replayCtx.waitUntilPromises)
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
			const { ctx, waitUntilPromises } = createCapturedWaitUntilContext()
			const message = createForwardableEmailMessage({
				from: 'sender@example.net',
				to: address,
				raw,
			})
			await handleInboundEmail(message, createInboundEnv(), ctx)
			await drainWaitUntil(waitUntilPromises)
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

			const replayCtx = createCapturedWaitUntilContext()
			const replay = createForwardableEmailMessage({
				from: 'sender@example.net',
				to: address,
				raw,
			})
			await handleInboundEmail(replay, createInboundEnv(), replayCtx.ctx)
			await drainWaitUntil(replayCtx.waitUntilPromises)
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

test.each([
	{ label: 'without an execution context', withContext: false },
	{ label: 'with an execution context', withContext: true },
])(
	'SMTP rejection survives a rejected D1 projection failure $label',
	async ({ withContext }) => {
		silenceIncidentalRuntimeWarnings([
			'inbound-email-rejected-projection-failed',
		])
		await ensureEmailTestSchema(env.APP_DB)
		const username = `mbx-rej-fail-${crypto.randomUUID().slice(0, 8)}`
		const accountEmail = `mbx-rej-fail-${crypto.randomUUID()}@example.com`
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
			'Subject: Permanent reject despite projection failure',
			`Message-ID: <mailbox-reject-failure-${crypto.randomUUID()}@example.net>`,
			'',
			'Body',
		].join('\r\n')
		const projection = createRejectProjectionFailingDb(env.APP_DB)
		const inboundEnv = {
			...createInboundEnv(),
			APP_DB: projection.db,
		}
		const captured = withContext ? createCapturedWaitUntilContext() : null
		const parseSpy = vi
			.spyOn(parser, 'parseForwardableEmailRawMime')
			.mockRejectedValueOnce(new Error('permanent parse rejection'))
		try {
			const message = createForwardableEmailMessage({
				from: 'sender@example.net',
				to: address,
				raw,
			})
			await handleInboundEmail(message, inboundEnv, captured?.ctx)

			expect(projection.didFail()).toBe(true)
			expect(message.rejectedReason).toBe('permanent parse rejection')
			expect(consoleWarn).toHaveBeenCalledWith(
				'inbound-email-rejected-projection-failed',
				userId,
				expect.any(String),
				expect.any(Error),
			)
			if (captured) await drainWaitUntil(captured.waitUntilPromises)

			const rejected = (
				await mailbox.listDeliveryEvents({ messageId: null, limit: 20 })
			).find((event) => event.eventType === 'rejected')
			expect(rejected).toMatchObject({
				eventType: 'rejected',
				provider: 'cloudflare-email-routing',
			})
			if (!rejected) throw new Error('Expected authoritative Mailbox rejection')
			expect(
				await env.APP_DB.prepare(
					`SELECT event_type FROM email_delivery_events
					WHERE id = ? AND user_id = ?`,
				)
					.bind(rejected.id, userId)
					.first<{ event_type: string }>(),
			).toEqual({ event_type: 'rejected' })
		} finally {
			parseSpy.mockRestore()
		}
	},
	inboundMailboxMirrorTimeoutMs,
)
