import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { planLimits } from '#worker/entitlements/plans.ts'
import {
	estimateEntitlementStorageEntryBytes,
	readUserD1StorageBytes,
} from '#worker/entitlements/service.ts'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { createWaitUntilDrain } from '#worker/test-support/user-meter.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { buildInboundDelivery } from './inbound-delivery.ts'
import { handleInboundEmail } from './inbound.ts'
import { listEmailMessages } from './repo.ts'
import { RetryableInboundStorageError } from './service.ts'
import { createForwardableEmailMessage } from './test-fixtures.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

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
	return { ctx, waitUntilPromises }
}

async function drainWaitUntil(waitUntilPromises: Array<Promise<unknown>>) {
	for (let index = 0; index < waitUntilPromises.length; index += 1) {
		await waitUntilPromises[index]
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

async function seedAccountWithPlan(input: {
	email: string
	plan: 'free' | 'max'
	d1StorageBytes?: number
}) {
	const username = `storage-meter-${crypto.randomUUID().slice(0, 8)}`
	const stableUserId = await createStableUserIdFromEmail(input.email)
	const now = new Date().toISOString()
	await env.APP_DB.prepare(
		`INSERT INTO users (
			username, email, password_hash, email_verified_at, plan, stable_user_id,
			d1_storage_bytes, d1_storage_bytes_updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			username,
			input.email,
			'test-password-hash',
			now,
			input.plan,
			stableUserId,
			input.d1StorageBytes ?? 0,
			now,
		)
		.run()
	return { username, address: `${username}@${platformDomain}`, stableUserId }
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

async function readAuthoritativeD1StorageBytes(userId: string) {
	return await readUserD1StorageBytes({ db: env.APP_DB, userId })
}

test(
	'inbound storage reservation shadows authoritative D1 bytes into UserMeter via waitUntil',
	async () => {
		silenceIncidentalRuntimeWarnings()
		await ensureEmailTestSchema(env.APP_DB)
		await ensureUsageRollupsTestSchema(env.APP_DB)

		const initialBytes = 512
		const staleMeterBytes = 999_999
		const email = `storage-meter-${crypto.randomUUID()}@example.com`
		const userId = await createStableUserIdFromEmail(email)
		const { address } = await seedAccountWithPlan({
			email,
			plan: 'free',
			d1StorageBytes: initialBytes,
		})
		const meter = userMeterRpc({ env, userId })
		await meter.setStorageBytes({
			bytes: staleMeterBytes,
			updatedAt: '2026-07-31T00:00:00.000Z',
		})

		const raw = [
			'From: Sender <sender@example.net>',
			`To: ${address}`,
			'Subject: Storage meter shadow',
			`Message-ID: <storage-meter-${crypto.randomUUID()}@example.net>`,
			'',
			'Reserve then shadow.',
		].join('\r\n')
		const message = createForwardableEmailMessage({
			from: 'sender@example.net',
			to: address,
			raw,
		})
		const reservedBytes = estimateInboundEmailStorageBytes({
			message,
			recipient: address,
		})
		// Direct/test callers may not have an ExecutionContext. The reservation
		// must await its caught UserMeter accounting task before returning.
		await handleInboundEmail(message, createInboundEnv())
		expect(message.rejectedReason).toBeNull()
		expect(
			await listEmailMessages({ db: env.APP_DB, userId, limit: 10 }),
		).toHaveLength(1)

		const authoritativeAfterReserve = initialBytes + reservedBytes
		expect(await readAuthoritativeD1StorageBytes(userId)).toBe(
			authoritativeAfterReserve,
		)

		expect(await meter.readStorageBytes()).toMatchObject({
			outcome: 'ready',
			bytes: authoritativeAfterReserve,
		})
		expect(await readAuthoritativeD1StorageBytes(userId)).toBe(
			authoritativeAfterReserve,
		)

		const storageLimit = planLimits.free.maxStorageBytes
		if (storageLimit === null) throw new Error('Expected a numeric free cap.')
		const atCapEmail = `storage-meter-cap-${crypto.randomUUID()}@example.com`
		const atCapUserId = await createStableUserIdFromEmail(atCapEmail)
		const { address: atCapAddress } = await seedAccountWithPlan({
			email: atCapEmail,
			plan: 'free',
			d1StorageBytes: storageLimit,
		})
		const atCapMeter = userMeterRpc({ env, userId: atCapUserId })
		await atCapMeter.setStorageBytes({
			bytes: 123,
			updatedAt: '2026-07-31T01:00:00.000Z',
		})
		const overQuotaDrain = createWaitUntilDrain()
		const overQuotaMessage = createForwardableEmailMessage({
			from: 'sender@example.net',
			to: atCapAddress,
			raw: [
				'From: Sender <sender@example.net>',
				`To: ${atCapAddress}`,
				'Subject: Over storage cap',
				`Message-ID: <over-cap-${crypto.randomUUID()}@example.net>`,
				'',
				'Denied.',
			].join('\r\n'),
		})
		await handleInboundEmail(overQuotaMessage, createInboundEnv(), {
			waitUntil: overQuotaDrain.waitUntil,
			passThroughOnException() {},
		} as ExecutionContext)
		expect(overQuotaMessage.rejectedReason).toBe(
			'Recipient mailbox is over quota.',
		)
		expect(await readAuthoritativeD1StorageBytes(atCapUserId)).toBe(
			storageLimit,
		)
		await overQuotaDrain.drain()
		expect(await atCapMeter.readStorageBytes()).toMatchObject({
			outcome: 'ready',
			bytes: 123,
		})

		const retryEmail = `storage-meter-retry-${crypto.randomUUID()}@example.com`
		const retryUserId = await createStableUserIdFromEmail(retryEmail)
		const { address: retryAddress } = await seedAccountWithPlan({
			email: retryEmail,
			plan: 'max',
			d1StorageBytes: 64,
		})
		const retryMeter = userMeterRpc({ env, userId: retryUserId })
		const retryRaw = [
			'From: Sender <sender@example.net>',
			`To: ${retryAddress}`,
			'Subject: Retry without double reserve',
			'Message-ID: <storage-meter-retry@example.net>',
			'',
			'Retry body.',
		].join('\r\n')
		const retryReservedBytes = estimateInboundEmailStorageBytes({
			message: createForwardableEmailMessage({
				from: 'sender@example.net',
				to: retryAddress,
				raw: retryRaw,
			}),
			recipient: retryAddress,
		})
		const failingEnv = {
			...createInboundEnv(),
			EMAIL_BLOBS: createFailingEmailBlobs(),
		} as Parameters<typeof handleInboundEmail>[1]
		const failCtx = createCapturedWaitUntilContext()
		const firstAttempt = createForwardableEmailMessage({
			from: 'sender@example.net',
			to: retryAddress,
			raw: retryRaw,
		})
		await expect(
			handleInboundEmail(firstAttempt, failingEnv, failCtx.ctx),
		).rejects.toBeInstanceOf(RetryableInboundStorageError)
		await drainWaitUntil(failCtx.waitUntilPromises)
		const bytesAfterFailedAttempt = 64 + retryReservedBytes
		expect(await readAuthoritativeD1StorageBytes(retryUserId)).toBe(
			bytesAfterFailedAttempt,
		)
		expect(await retryMeter.readStorageBytes()).toMatchObject({
			outcome: 'ready',
			bytes: bytesAfterFailedAttempt,
		})

		const retryCtx = createCapturedWaitUntilContext()
		const retryAttempt = createForwardableEmailMessage({
			from: 'sender@example.net',
			to: retryAddress,
			raw: retryRaw,
		})
		await handleInboundEmail(retryAttempt, createInboundEnv(), retryCtx.ctx)
		await drainWaitUntil(retryCtx.waitUntilPromises)
		expect(retryAttempt.rejectedReason).toBeNull()
		expect(await readAuthoritativeD1StorageBytes(retryUserId)).toBe(
			bytesAfterFailedAttempt,
		)
		expect(await retryMeter.readStorageBytes()).toMatchObject({
			outcome: 'ready',
			bytes: bytesAfterFailedAttempt,
		})

		const candidate = await buildInboundDelivery({
			userId: retryUserId,
			inboxId: 'unused',
			recipient: retryAddress,
			envelopeFrom: 'sender@example.net',
			rawMime: retryRaw,
			quotaDay: new Date().toISOString().slice(0, 10),
		})
		expect(
			await listEmailMessages({
				db: env.APP_DB,
				userId: retryUserId,
				limit: 1,
			}),
		).toMatchObject([{ id: candidate.messageId }])
	},
	inboundStorageMeterTimeoutMs,
)
