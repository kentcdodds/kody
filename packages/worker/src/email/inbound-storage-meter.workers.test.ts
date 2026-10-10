import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { planLimits } from '#universal/plans.ts'
import { estimateEntitlementStorageEntryBytes } from '#worker/entitlements/service.ts'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { createWaitUntilDrain } from '#worker/test-support/user-meter.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'
import { buildInboundDelivery } from './inbound-delivery.ts'
import { handleInboundEmail } from './inbound.ts'
import { mailboxRpc } from './mailbox-client.ts'
import { RetryableInboundStorageError } from './service.ts'
import { createForwardableEmailMessage } from './test-fixtures.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { ensureEmailTestSchema } from './test-schema.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
const platformBaseUrl = 'https://kody.example.com'
const platformDomain = 'inbox.kody.example.com'
const inboundStorageMeterTimeoutMs = 30_000

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
	return {
		ctx,
		drain: async () => {
			for (const promise of waitUntilPromises) await promise
		},
	}
}

function estimateInboundEmailStorageBytes(input: {
	message: ForwardableEmailMessage
	recipient: string
}) {
	return (
		input.message.rawSize * 2 +
		estimateEntitlementStorageEntryBytes({
			value: {
				from: input.message.from,
				to: input.message.to,
				recipient: input.recipient,
				headers: Object.fromEntries(input.message.headers.entries()),
			},
		})
	)
}

async function seedAccountWithPlan(label: string, plan: 'free' | 'max') {
	const username = `${label}-${crypto.randomUUID().slice(0, 8)}`
	const email = `${username}@example.com`
	const userId = testStableUserIdFromEmail(email)
	await env.APP_DB.prepare(
		`INSERT INTO users (
			username, email, password_hash, email_verified_at, stable_user_id
		) VALUES (?, ?, 'test-password-hash', ?, ?)`,
	)
		.bind(username, email, new Date().toISOString(), userId)
		.run()
	await provisionPersonalOrg(env.APP_DB, {
		stableUserId: userId,
		username,
		plan,
	})
	const address = `${username}@${platformDomain}`
	return {
		address,
		userId,
		meter: userMeterRpc({ env, userId: ownerIdFromStored(userId) }),
	}
}

function rawMail(address: string, subject: string, messageId: string) {
	return [
		'From: Sender <sender@example.net>',
		`To: ${address}`,
		`Subject: ${subject}`,
		`Message-ID: <${messageId}@example.net>`,
		'',
		'Body.',
	].join('\r\n')
}

function mailFrom(address: string, raw: string) {
	return createForwardableEmailMessage({
		from: 'sender@example.net',
		to: address,
		raw,
	})
}

function createFailingEmailBlobs() {
	return new Proxy(env.EMAIL_BLOBS, {
		get(target, property, receiver) {
			if (property === 'put') {
				return async () => {
					throw new Error('simulated inbound blob put failure')
				}
			}
			const value = Reflect.get(target, property, receiver)
			return typeof value === 'function' ? value.bind(target) : value
		},
	})
}

test(
	'inbound storage reservation is UserMeter-authoritative',
	async () => {
		silenceIncidentalRuntimeWarnings()
		await ensureEmailTestSchema(env.APP_DB)
		await ensureUsageRollupsTestSchema(env.APP_DB)

		// Part 1: UserMeter is authoritative. It starts empty; the reserve path
		// zero-initializes on cold bootstrap, then seed it to a known baseline.
		const initialBytes = 512
		const account = await seedAccountWithPlan('storage-meter', 'free')
		await account.meter.initializeStorageBytes({
			bytes: initialBytes,
			updatedAt: '2026-07-31T00:00:00.000Z',
		})
		const message = mailFrom(
			account.address,
			rawMail(
				account.address,
				'Storage meter shadow',
				`storage-meter-${crypto.randomUUID()}`,
			),
		)
		const reservedBytes = estimateInboundEmailStorageBytes({
			message,
			recipient: account.address,
		})
		// Direct/test callers may not have an ExecutionContext. The reservation
		// must await its caught UserMeter accounting task before returning.
		await handleInboundEmail(message, createInboundEnv())
		expect(message.rejectedReason).toBeNull()
		expect(
			await mailboxRpc({
				env,
				userId: ownerIdFromStored(account.userId),
			}).listMessages({
				limit: 10,
			}),
		).toMatchObject({
			messages: [expect.objectContaining({ direction: 'inbound' })],
		})
		// UserMeter is authoritative and reflects the reservation immediately.
		expect(await account.meter.readStorageBytes()).toMatchObject({
			outcome: 'ready',
			bytes: initialBytes + reservedBytes,
		})

		// Part 2: at-cap uses UserMeter; D1 value is irrelevant for the limit.
		const storageLimit = planLimits.free.maxStorageBytes
		if (storageLimit === null) throw new Error('Expected a numeric free cap.')
		const atCap = await seedAccountWithPlan('storage-meter-cap', 'free')
		await atCap.meter.setStorageBytes({
			bytes: storageLimit,
			updatedAt: '2026-07-31T01:00:00.000Z',
		})
		const overQuotaDrain = createWaitUntilDrain()
		const overQuotaMessage = mailFrom(
			atCap.address,
			rawMail(
				atCap.address,
				'Over storage cap',
				`over-cap-${crypto.randomUUID()}`,
			),
		)
		await handleInboundEmail(overQuotaMessage, createInboundEnv(), {
			waitUntil: overQuotaDrain.waitUntil,
			passThroughOnException() {},
		} as ExecutionContext)
		expect(overQuotaMessage.rejectedReason).toBe(
			'Recipient mailbox is over quota.',
		)
		await overQuotaDrain.drain()
		// UserMeter stays at storageLimit after a denied reservation.
		expect(await atCap.meter.readStorageBytes()).toMatchObject({
			outcome: 'ready',
			bytes: storageLimit,
		})

		// Part 3: retry deduplication — failed blob write does not double-count.
		const retry = await seedAccountWithPlan('storage-meter-retry', 'max')
		await retry.meter.initializeStorageBytes({
			bytes: 64,
			updatedAt: '2026-07-31T00:00:00.000Z',
		})
		const retryRaw = rawMail(
			retry.address,
			'Retry without double reserve',
			'storage-meter-retry',
		)
		const bytesAfterFailedAttempt =
			64 +
			estimateInboundEmailStorageBytes({
				message: mailFrom(retry.address, retryRaw),
				recipient: retry.address,
			})
		const failingEnv = {
			...createInboundEnv(),
			EMAIL_BLOBS: createFailingEmailBlobs(),
		} as Parameters<typeof handleInboundEmail>[1]
		const failCtx = createCapturedWaitUntilContext()
		await expect(
			handleInboundEmail(
				mailFrom(retry.address, retryRaw),
				failingEnv,
				failCtx.ctx,
			),
		).rejects.toBeInstanceOf(RetryableInboundStorageError)
		await failCtx.drain()
		expect(await retry.meter.readStorageBytes()).toMatchObject({
			outcome: 'ready',
			bytes: bytesAfterFailedAttempt,
		})

		const retryCtx = createCapturedWaitUntilContext()
		const retryAttempt = mailFrom(retry.address, retryRaw)
		await handleInboundEmail(retryAttempt, createInboundEnv(), retryCtx.ctx)
		await retryCtx.drain()
		expect(retryAttempt.rejectedReason).toBeNull()
		// No double-count: UserMeter unchanged after retry.
		expect(await retry.meter.readStorageBytes()).toMatchObject({
			outcome: 'ready',
			bytes: bytesAfterFailedAttempt,
		})
		const candidate = await buildInboundDelivery({
			userId: ownerIdFromStored(retry.userId),
			inboxId: 'unused',
			recipient: retry.address,
			envelopeFrom: 'sender@example.net',
			rawMime: retryRaw,
			quotaDay: new Date().toISOString().slice(0, 10),
		})
		expect(
			await mailboxRpc({
				env,
				userId: ownerIdFromStored(retry.userId),
			}).listMessages({
				limit: 1,
			}),
		).toMatchObject({ messages: [{ id: candidate.messageId }] })
	},
	inboundStorageMeterTimeoutMs,
)
