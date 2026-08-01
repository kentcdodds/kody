import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import { maxPlanEmailLimits, planLimits } from '#worker/entitlements/plans.ts'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import { UserMeter } from '#worker/entitlements/user-meter-do.ts'
import {
	createWaitUntilDrain,
	withPatchedDbPrepare,
} from '#worker/test-support/user-meter.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { userMeterDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import {
	buildInboundDelivery,
	chargeUserInboundDeliveryOnce,
	readUserInboundReceiveCount,
} from './inbound-delivery.ts'
import { handleInboundEmail } from './inbound.ts'
import { listEmailMessages } from './repo.ts'
import { maxDetailedEmailRejectionEventsPerDay } from './service.ts'
import { createForwardableEmailMessage } from './test-fixtures.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

const platformBaseUrl = 'https://kody.example.com'
const platformDomain = 'inbox.kody.example.com'

function createInboundEnv() {
	return { ...env, APP_BASE_URL: platformBaseUrl }
}

async function seedAccountWithPlan(input: {
	email: string
	plan: 'free' | 'max'
	emailVerifiedAt?: string | null
}) {
	const username = `quota-${crypto.randomUUID().slice(0, 8)}`
	const stableUserId = await createStableUserIdFromEmail(input.email)
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, email_verified_at, plan, stable_user_id)
			VALUES (?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			username,
			input.email,
			'test-password-hash',
			input.emailVerifiedAt === undefined
				? new Date().toISOString()
				: input.emailVerifiedAt,
			input.plan,
			stableUserId,
		)
		.run()
	return { username, address: `${username}@${platformDomain}`, stableUserId }
}

function buildInboundMessage(address: string) {
	return createForwardableEmailMessage({
		from: 'sender@example.net',
		to: address,
		raw: [
			'From: Sender <sender@example.net>',
			`To: ${address}`,
			'Subject: Quota test',
			`Message-ID: <quota-${crypto.randomUUID()}@example.net>`,
			'',
			'Quota body.',
		].join('\r\n'),
	})
}

async function seedDailyReceiveCounter(userId: string, count: number) {
	const day = utcDayKey()
	const updatedAt = new Date().toISOString()
	const stub = env.USER_METER.get(
		env.USER_METER.idFromName(userMeterDurableObjectName(userId)),
	)
	await runInDurableObject(stub, async (instance: UserMeter, state) => {
		expect(instance).toBeInstanceOf(UserMeter)
		await instance.read({ resource: 'email_receives_per_day', day })
		state.storage.sql.exec(
			`INSERT INTO daily_counters (resource, day, count, revision, updated_at)
			VALUES (?, ?, ?, 1, ?)
			ON CONFLICT(resource, day) DO UPDATE SET
				count = excluded.count,
				revision = excluded.revision,
				updated_at = excluded.updated_at`,
			'email_receives_per_day',
			day,
			count,
			updatedAt,
		)
	})
	await env.APP_DB.prepare(
		`INSERT INTO entitlement_daily_counters (user_id, resource, day, count, updated_at)
			VALUES (?, 'email_receives_per_day', ?, ?, ?)
			ON CONFLICT(user_id, resource, day) DO UPDATE SET
				count = excluded.count,
				updated_at = excluded.updated_at`,
	)
		.bind(userId, day, count, updatedAt)
		.run()
}

async function readDailyReceiveCounter(userId: string) {
	const result = await userMeterRpc({ env, userId }).read({
		resource: 'email_receives_per_day',
		day: utcDayKey(),
	})
	return result.outcome === 'ready' ? result.count : 0
}

async function bulkInsertStoredMessages(userId: string, count: number) {
	await env.APP_DB.prepare(
		`WITH RECURSIVE seq(n) AS (
			SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?2
		)
		INSERT INTO email_messages (
			id, direction, user_id, from_address, subject,
			processing_status, created_at, updated_at
		)
		SELECT ?1 || '-bulk-' || n, 'inbound', ?1, 'bulk@example.com', 'Bulk',
			'stored', ?3, ?3
		FROM seq`,
	)
		.bind(userId, count, new Date().toISOString())
		.run()
}

async function insertStoredMessageBytes(userId: string, rawSize: number) {
	const now = new Date().toISOString()
	await env.APP_DB.prepare(
		`INSERT INTO email_messages (
			id, direction, user_id, from_address, subject, raw_size,
			processing_status, created_at, updated_at
		) VALUES (?, 'inbound', ?, 'bulk@example.com', 'Bulk', ?, 'stored', ?, ?)`,
	)
		.bind(`storage-bytes-${crypto.randomUUID()}`, userId, rawSize, now, now)
		.run()
	await env.APP_DB.prepare(
		`UPDATE users
		SET d1_storage_bytes = ?,
			d1_storage_bytes_updated_at = ?
		WHERE stable_user_id = ?`,
	)
		.bind(rawSize, now, userId)
		.run()
}

async function readRejectionEvents(userId: string) {
	const { results } = await env.APP_DB.prepare(
		`SELECT id, detail_json FROM email_delivery_events
			WHERE user_id = ? AND event_type = 'rejected'
			ORDER BY created_at ASC, id ASC`,
	)
		.bind(userId)
		.all<{ id: string; detail_json: string }>()
	const rows = (results ?? []).map((row) => ({
		id: row.id,
		detail: JSON.parse(row.detail_json) as Record<string, unknown>,
	}))
	return {
		detailed: rows.filter((row) => row.detail['aggregate'] !== true),
		aggregate: rows.find((row) => row.detail['aggregate'] === true) ?? null,
	}
}

async function readEmailReceivedRollup(userId: string) {
	return await env.APP_DB.prepare(
		`SELECT event_count, error_count, total_bytes FROM usage_rollups
			WHERE user_id = ? AND metric = 'email_received' AND month = ?`,
	)
		.bind(userId, new Date().toISOString().slice(0, 7))
		.first<{ event_count: number; error_count: number; total_bytes: number }>()
}

async function buildChargeableDelivery(input: {
	userId: string
	inboxId: string
	address: string
	raw?: string
}) {
	const now = new Date()
	const raw =
		input.raw ??
		[
			'From: Sender <sender@example.net>',
			`To: ${input.address}`,
			'Subject: Charge once',
			`Message-ID: <charge-${crypto.randomUUID()}@example.net>`,
			'',
			'Body',
		].join('\r\n')
	return await buildInboundDelivery({
		userId: input.userId,
		inboxId: input.inboxId,
		recipient: input.address,
		envelopeFrom: 'sender@example.net',
		rawMime: raw,
		quotaDay: utcDayKey(now),
		now,
	})
}

function withFailingReceiveStartedInsert(input: {
	deliveryId: string
	message: string
}) {
	let failNext = true
	return withPatchedDbPrepare(env.APP_DB, (originalPrepare) => {
		return ((query: string) => {
			const statement = originalPrepare(query)
			const isDeliveryInsert =
				query.includes('INSERT OR IGNORE INTO email_delivery_events') &&
				query.includes("'receive_started'")
			if (!isDeliveryInsert) return statement
			const originalBind = statement.bind.bind(statement)
			return {
				bind(...params: Array<unknown>) {
					const bound = originalBind(...params)
					return {
						first: bound.first.bind(bound),
						all: bound.all.bind(bound),
						raw: bound.raw?.bind(bound),
						run: async () => {
							if (failNext && params[0] === input.deliveryId) {
								failNext = false
								throw new Error(input.message)
							}
							return await bound.run()
						},
					}
				},
			}
		}) as D1Database['prepare']
	})
}

test('inbound email enforces free-plan receive, storage, and size limits then stores under quota', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)

	const receiveLimitEmail = `receive-limit-${crypto.randomUUID()}@example.com`
	const receiveLimitUserId =
		await createStableUserIdFromEmail(receiveLimitEmail)
	const receiveLimit = planLimits.free.maxEmailReceivesPerDay
	if (receiveLimit === null) throw new Error('Expected a numeric free limit.')
	const { address: receiveLimitAddress } = await seedAccountWithPlan({
		email: receiveLimitEmail,
		plan: 'free',
	})
	await seedDailyReceiveCounter(receiveLimitUserId, receiveLimit)

	const receiveLimitMessage = buildInboundMessage(receiveLimitAddress)
	await handleInboundEmail(receiveLimitMessage, createInboundEnv())
	expect(receiveLimitMessage.rejectedReason).toBe(
		'Recipient mailbox is over quota.',
	)
	expect(
		await listEmailMessages({
			db: env.APP_DB,
			userId: receiveLimitUserId,
			limit: 10,
		}),
	).toEqual([])
	expect(await readDailyReceiveCounter(receiveLimitUserId)).toBe(receiveLimit)
	const receiveLimitRejections = await readRejectionEvents(receiveLimitUserId)
	expect(receiveLimitRejections.detailed).toHaveLength(1)
	expect(receiveLimitRejections.detailed[0]?.detail).toMatchObject({
		phase: 'entitlement',
	})
	expect(receiveLimitRejections.aggregate?.detail).toMatchObject({ count: 1 })
	expect(await readEmailReceivedRollup(receiveLimitUserId)).toMatchObject({
		event_count: 1,
		error_count: 1,
	})
	expect(
		await env.APP_DB.prepare(
			`SELECT id FROM email_delivery_events
			WHERE user_id = ? AND provider = 'cloudflare-email-routing-dedupe'`,
		)
			.bind(receiveLimitUserId)
			.first(),
	).toBeNull()

	const storageCapEmail = `storage-cap-${crypto.randomUUID()}@example.com`
	const storageCapUserId = await createStableUserIdFromEmail(storageCapEmail)
	const storageCap = planLimits.free.maxStoredEmailMessages
	if (storageCap === null) throw new Error('Expected a numeric free cap.')
	const { address: storageCapAddress } = await seedAccountWithPlan({
		email: storageCapEmail,
		plan: 'free',
	})
	await bulkInsertStoredMessages(storageCapUserId, storageCap)

	const storageCapMessage = buildInboundMessage(storageCapAddress)
	await handleInboundEmail(storageCapMessage, createInboundEnv())
	expect(storageCapMessage.rejectedReason).toBe(
		'Recipient mailbox is over quota.',
	)
	expect(
		await listEmailMessages({
			db: env.APP_DB,
			userId: storageCapUserId,
			limit: storageCap + 10,
		}),
	).toHaveLength(storageCap)
	expect(await readDailyReceiveCounter(storageCapUserId)).toBe(0)
	expect(
		(await readRejectionEvents(storageCapUserId)).detailed[0]?.detail,
	).toMatchObject({
		phase: 'entitlement',
	})
	expect(
		await env.APP_DB.prepare(
			`SELECT id FROM email_delivery_events
			WHERE user_id = ? AND provider = 'cloudflare-email-routing-dedupe'`,
		)
			.bind(storageCapUserId)
			.first(),
	).toBeNull()

	const storageBytesEmail = `storage-bytes-${crypto.randomUUID()}@example.com`
	const storageBytesUserId =
		await createStableUserIdFromEmail(storageBytesEmail)
	const storageBytesLimit = planLimits.free.maxStorageBytes
	if (storageBytesLimit === null)
		throw new Error('Expected a numeric free storage byte cap.')
	const { address: storageBytesAddress } = await seedAccountWithPlan({
		email: storageBytesEmail,
		plan: 'free',
	})
	await insertStoredMessageBytes(storageBytesUserId, storageBytesLimit)

	const storageBytesMessage = buildInboundMessage(storageBytesAddress)
	await handleInboundEmail(storageBytesMessage, createInboundEnv())
	expect(storageBytesMessage.rejectedReason).toBe(
		'Recipient mailbox is over quota.',
	)
	expect(await readDailyReceiveCounter(storageBytesUserId)).toBe(0)
	expect(
		(await readRejectionEvents(storageBytesUserId)).detailed[0]?.detail,
	).toMatchObject({
		phase: 'entitlement',
	})

	const oversizeEmail = `oversize-${crypto.randomUUID()}@example.com`
	const oversizeUserId = await createStableUserIdFromEmail(oversizeEmail)
	const maxBytes = planLimits.free.maxEmailMessageBytes
	if (maxBytes === null) throw new Error('Expected a numeric size cap.')
	const { address: oversizeAddress } = await seedAccountWithPlan({
		email: oversizeEmail,
		plan: 'free',
	})
	const oversizeMessage = buildInboundMessage(oversizeAddress)
	const oversizeBytes = maxBytes + 1
	Object.defineProperty(oversizeMessage, 'rawSize', { value: oversizeBytes })
	await handleInboundEmail(oversizeMessage, createInboundEnv())
	expect(oversizeMessage.rejectedReason).toBe(
		'Recipient mailbox is over quota.',
	)
	expect(await readDailyReceiveCounter(oversizeUserId)).toBe(0)
	expect(
		(await readRejectionEvents(oversizeUserId)).detailed[0]?.detail,
	).toMatchObject({
		phase: 'size',
	})
	expect(await readEmailReceivedRollup(oversizeUserId)).toMatchObject({
		event_count: 1,
		error_count: 1,
		total_bytes: oversizeBytes,
	})

	const underQuotaEmail = `under-quota-${crypto.randomUUID()}@example.com`
	const underQuotaUserId = await createStableUserIdFromEmail(underQuotaEmail)
	const { address: underQuotaAddress } = await seedAccountWithPlan({
		email: underQuotaEmail,
		plan: 'free',
	})
	const underQuotaMessage = buildInboundMessage(underQuotaAddress)
	await handleInboundEmail(underQuotaMessage, createInboundEnv())
	expect(underQuotaMessage.rejectedReason).toBeNull()
	expect(
		await listEmailMessages({
			db: env.APP_DB,
			userId: underQuotaUserId,
			limit: 10,
		}),
	).toHaveLength(1)
	expect(await readDailyReceiveCounter(underQuotaUserId)).toBe(1)
	expect(await readEmailReceivedRollup(underQuotaUserId)).toMatchObject({
		event_count: 1,
		error_count: 0,
		total_bytes: underQuotaMessage.rawSize,
	})
})

test('inbound email applies the max-plan email receive backstop', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const email = `fallback-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	const { address } = await seedAccountWithPlan({ email, plan: 'max' })
	const receiveLimit = maxPlanEmailLimits.email_receives_per_day
	await seedDailyReceiveCounter(userId, receiveLimit)

	const message = buildInboundMessage(address)
	await handleInboundEmail(message, createInboundEnv())

	expect(message.rejectedReason).toBe('Recipient mailbox is over quota.')
	expect((await readRejectionEvents(userId)).detailed[0]?.detail).toMatchObject(
		{
			phase: 'entitlement',
		},
	)
})

test('inbound email stores at most five detailed rejection events per inbox per day', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const email = `rejection-bound-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	const limit = planLimits.free.maxEmailReceivesPerDay
	if (limit === null) throw new Error('Expected a numeric free limit.')
	const { address } = await seedAccountWithPlan({ email, plan: 'free' })
	await seedDailyReceiveCounter(userId, limit)

	const attempts = maxDetailedEmailRejectionEventsPerDay + 3
	for (let index = 0; index < attempts; index += 1) {
		const message = buildInboundMessage(address)
		await handleInboundEmail(message, createInboundEnv())
		expect(message.rejectedReason).toBe('Recipient mailbox is over quota.')
	}

	const rejections = await readRejectionEvents(userId)
	expect(rejections.detailed).toHaveLength(
		maxDetailedEmailRejectionEventsPerDay,
	)
	expect(rejections.aggregate?.detail).toMatchObject({
		aggregate: true,
		count: attempts,
		last_phase: 'entitlement',
	})
	expect(await readEmailReceivedRollup(userId)).toMatchObject({
		event_count: attempts,
		error_count: attempts,
	})
})

test('inbound UserMeter delivery claims are idempotent, isolated, and over-limit exact', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const receiveLimit = planLimits.free.maxEmailReceivesPerDay
	if (receiveLimit === null) throw new Error('Expected a numeric free limit.')

	const userAEmail = `meter-a-${crypto.randomUUID()}@example.com`
	const userBEmail = `meter-b-${crypto.randomUUID()}@example.com`
	const userAId = await createStableUserIdFromEmail(userAEmail)
	const userBId = await createStableUserIdFromEmail(userBEmail)
	const userA = await seedAccountWithPlan({ email: userAEmail, plan: 'free' })
	const userB = await seedAccountWithPlan({ email: userBEmail, plan: 'free' })
	const inboxA = `inbox-a-${crypto.randomUUID()}`
	const inboxB = `inbox-b-${crypto.randomUUID()}`
	const now = new Date()
	const day = utcDayKey(now)
	const drain = createWaitUntilDrain()

	const deliveryA = await buildChargeableDelivery({
		userId: userAId,
		inboxId: inboxA,
		address: userA.address,
	})
	const deliveryARetry = { ...deliveryA }
	const sharedDeliveryId = deliveryA.deliveryId

	const concurrent = await Promise.all([
		chargeUserInboundDeliveryOnce({
			db: env.APP_DB,
			env,
			delivery: deliveryA,
			plan: 'free',
			limit: receiveLimit,
			now,
			waitUntil: drain.waitUntil,
		}),
		chargeUserInboundDeliveryOnce({
			db: env.APP_DB,
			env,
			delivery: deliveryARetry,
			plan: 'free',
			limit: receiveLimit,
			now,
			waitUntil: drain.waitUntil,
		}),
	])
	expect(concurrent[0]?.deliveryId).toBe(sharedDeliveryId)
	expect(concurrent[1]?.deliveryId).toBe(sharedDeliveryId)
	expect(await readDailyReceiveCounter(userAId)).toBe(1)
	expect(
		await env.APP_DB.prepare(
			`SELECT COUNT(*) AS count FROM email_delivery_events
			WHERE id = ? AND user_id = ?`,
		)
			.bind(sharedDeliveryId, userAId)
			.first<{ count: number }>(),
	).toEqual({ count: 1 })

	const failingDelivery = await buildChargeableDelivery({
		userId: userAId,
		inboxId: inboxA,
		address: userA.address,
		raw: [
			'From: Sender <sender@example.net>',
			`To: ${userA.address}`,
			'Subject: Fail then retry',
			`Message-ID: <fail-retry-${crypto.randomUUID()}@example.net>`,
			'',
			'Retry body.',
		].join('\r\n'),
	})
	using _patch = withFailingReceiveStartedInsert({
		deliveryId: failingDelivery.deliveryId,
		message: 'simulated D1 delivery event insert failure',
	})

	await expect(
		chargeUserInboundDeliveryOnce({
			db: env.APP_DB,
			env,
			delivery: failingDelivery,
			plan: 'free',
			limit: receiveLimit,
			now,
			waitUntil: drain.waitUntil,
		}),
	).rejects.toThrow('simulated D1 delivery event insert failure')
	expect(await readDailyReceiveCounter(userAId)).toBe(2)
	expect(
		await env.APP_DB.prepare(
			`SELECT id FROM email_delivery_events
			WHERE id = ? AND user_id = ?`,
		)
			.bind(failingDelivery.deliveryId, userAId)
			.first(),
	).toBeNull()

	const recovered = await chargeUserInboundDeliveryOnce({
		db: env.APP_DB,
		env,
		delivery: failingDelivery,
		plan: 'free',
		limit: receiveLimit,
		now,
		waitUntil: drain.waitUntil,
	})
	expect(recovered.deliveryId).toBe(failingDelivery.deliveryId)
	expect(await readDailyReceiveCounter(userAId)).toBe(2)
	expect(
		await env.APP_DB.prepare(
			`SELECT id FROM email_delivery_events
			WHERE id = ? AND user_id = ?`,
		)
			.bind(failingDelivery.deliveryId, userAId)
			.first(),
	).not.toBeNull()

	const deliveryB = await buildChargeableDelivery({
		userId: userBId,
		inboxId: inboxB,
		address: userB.address,
	})
	await chargeUserInboundDeliveryOnce({
		db: env.APP_DB,
		env,
		delivery: deliveryB,
		plan: 'free',
		limit: receiveLimit,
		now,
		waitUntil: drain.waitUntil,
	})
	expect(await readDailyReceiveCounter(userAId)).toBe(2)
	expect(await readDailyReceiveCounter(userBId)).toBe(1)
	expect(
		await readUserInboundReceiveCount({
			db: env.APP_DB,
			env,
			userId: userBId,
			day,
			now,
		}),
	).toBe(1)

	const sharedClaimId = `email-inbound-delivery:shared-${crypto.randomUUID()}`
	const meterA = userMeterRpc({ env, userId: userAId })
	const meterB = userMeterRpc({ env, userId: userBId })
	const claimA = await meterA.consumeInboundDelivery({
		deliveryId: sharedClaimId,
		resource: 'email_receives_per_day',
		day,
		limit: receiveLimit,
		updatedAt: now.toISOString(),
	})
	const claimB = await meterB.consumeInboundDelivery({
		deliveryId: sharedClaimId,
		resource: 'email_receives_per_day',
		day,
		limit: receiveLimit,
		updatedAt: now.toISOString(),
	})
	expect(claimA).toMatchObject({
		outcome: 'ready',
		consumed: true,
		replayed: false,
		count: 3,
		day,
		resource: 'email_receives_per_day',
	})
	expect(claimB).toMatchObject({
		outcome: 'ready',
		consumed: true,
		replayed: false,
		count: 2,
		day,
		resource: 'email_receives_per_day',
	})
	const replayA = await meterA.consumeInboundDelivery({
		deliveryId: sharedClaimId,
		resource: 'email_receives_per_day',
		day,
		limit: receiveLimit,
		updatedAt: now.toISOString(),
	})
	expect(replayA).toMatchObject({
		outcome: 'ready',
		consumed: false,
		replayed: true,
		count: 3,
		day,
		resource: 'email_receives_per_day',
	})
	expect(await readDailyReceiveCounter(userAId)).toBe(3)
	expect(await readDailyReceiveCounter(userBId)).toBe(2)

	await seedDailyReceiveCounter(userAId, receiveLimit)
	const overLimitDelivery = await buildChargeableDelivery({
		userId: userAId,
		inboxId: inboxA,
		address: userA.address,
		raw: [
			'From: Sender <sender@example.net>',
			`To: ${userA.address}`,
			'Subject: Over limit',
			`Message-ID: <over-${crypto.randomUUID()}@example.net>`,
			'',
			'Denied.',
		].join('\r\n'),
	})
	const denied = await chargeUserInboundDeliveryOnce({
		db: env.APP_DB,
		env,
		delivery: overLimitDelivery,
		plan: 'free',
		limit: receiveLimit,
		now,
		waitUntil: drain.waitUntil,
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	expect(isEntitlementLimitError(denied)).toBe(true)
	expect(denied).toMatchObject({
		details: {
			code: 'entitlement_limit_exceeded',
			resource: 'email_receives_per_day',
			plan: 'free',
			limit: receiveLimit,
			current: receiveLimit,
		},
	})
	expect(await readDailyReceiveCounter(userAId)).toBe(receiveLimit)
	await drain.drain()
}, 30_000)

test('inbound UserMeter claim+consume rolls back together when claim insert fails', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const email = `meter-atomic-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	await seedAccountWithPlan({ email, plan: 'free' })
	const day = '2026-07-30'
	const updatedAt = '2026-07-30T12:00:00.000Z'
	const deliveryId = `email-inbound-delivery:atomic-${crypto.randomUUID()}`
	const stub = env.USER_METER.get(
		env.USER_METER.idFromName(userMeterDurableObjectName(userId)),
	)

	await runInDurableObject(stub, async (instance: UserMeter, state) => {
		expect(instance).toBeInstanceOf(UserMeter)
		await instance.initialize({
			resource: 'email_receives_per_day',
			day,
			count: 0,
			updatedAt,
		})

		const sql = state.storage.sql
		const originalExec = sql.exec.bind(sql)
		sql.exec = ((query: string, ...bindings: Array<unknown>) => {
			if (
				typeof query === 'string' &&
				query.includes('INSERT INTO inbound_delivery_claims')
			) {
				throw new Error('injected inbound claim insert failure')
			}
			return originalExec(query, ...bindings)
		}) as typeof sql.exec

		const receiveLimit = planLimits.free.maxEmailReceivesPerDay
		if (receiveLimit === null) throw new Error('Expected a numeric free limit.')

		await expect(
			instance.consumeInboundDelivery({
				deliveryId,
				resource: 'email_receives_per_day',
				day,
				limit: receiveLimit,
				updatedAt,
			}),
		).rejects.toThrow('injected inbound claim insert failure')

		sql.exec = originalExec

		expect(
			await instance.read({ resource: 'email_receives_per_day', day }),
		).toMatchObject({ outcome: 'ready', count: 0 })
		expect(
			state.storage.sql
				.exec<{ n: number }>(
					`SELECT COUNT(*) AS n FROM inbound_delivery_claims
					WHERE delivery_id = ?`,
					deliveryId,
				)
				.toArray()[0]?.n,
		).toBe(0)

		const accepted = await instance.consumeInboundDelivery({
			deliveryId,
			resource: 'email_receives_per_day',
			day,
			limit: receiveLimit,
			updatedAt,
		})
		expect(accepted).toMatchObject({
			outcome: 'ready',
			consumed: true,
			replayed: false,
			count: 1,
			day,
			resource: 'email_receives_per_day',
		})
		expect(
			state.storage.sql
				.exec<{ n: number }>(
					`SELECT COUNT(*) AS n FROM inbound_delivery_claims
					WHERE delivery_id = ?`,
					deliveryId,
				)
				.toArray()[0]?.n,
		).toBe(1)

		const foreignDeliveryId = `email-inbound-delivery:foreign-${crypto.randomUUID()}`
		state.storage.sql.exec(
			`INSERT INTO inbound_delivery_claims (
				delivery_id, resource, day, count_after, revision, claimed_at
			) VALUES (?, 'email_sends_per_day', ?, 1, 1, ?)`,
			foreignDeliveryId,
			day,
			updatedAt,
		)
		await expect(
			instance.consumeInboundDelivery({
				deliveryId: foreignDeliveryId,
				resource: 'email_receives_per_day',
				day,
				limit: receiveLimit,
				updatedAt,
			}),
		).rejects.toThrow(/was claimed for "email_sends_per_day"/)
	})
})

test('inbound UserMeter replay keeps original claim day across UTC midnight', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const receiveLimit = planLimits.free.maxEmailReceivesPerDay
	if (receiveLimit === null) throw new Error('Expected a numeric free limit.')

	const email = `meter-cross-day-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	const account = await seedAccountWithPlan({ email, plan: 'free' })
	const inboxId = `inbox-cross-${crypto.randomUUID()}`
	const dayN = '2026-07-30'
	const dayN1 = '2026-07-31'
	const drain = createWaitUntilDrain()
	const meter = userMeterRpc({ env, userId })

	await meter.initialize({
		resource: 'email_receives_per_day',
		day: dayN,
		count: 0,
		updatedAt: `${dayN}T23:50:00.000Z`,
	})

	const delivery = await buildInboundDelivery({
		userId,
		inboxId,
		recipient: account.address,
		envelopeFrom: 'sender@example.net',
		rawMime: [
			'From: Sender <sender@example.net>',
			`To: ${account.address}`,
			'Subject: Cross-day retry',
			`Message-ID: <cross-day-${crypto.randomUUID()}@example.net>`,
			'',
			'Body',
		].join('\r\n'),
		quotaDay: dayN,
		now: new Date(`${dayN}T23:59:00.000Z`),
	})

	using _patch = withFailingReceiveStartedInsert({
		deliveryId: delivery.deliveryId,
		message: 'simulated cross-day D1 insert failure',
	})

	await expect(
		chargeUserInboundDeliveryOnce({
			db: env.APP_DB,
			env,
			delivery,
			plan: 'free',
			limit: receiveLimit,
			now: new Date(`${dayN}T23:59:30.000Z`),
			waitUntil: drain.waitUntil,
		}),
	).rejects.toThrow('simulated cross-day D1 insert failure')

	expect(
		await meter.read({ resource: 'email_receives_per_day', day: dayN }),
	).toMatchObject({ outcome: 'ready', count: 1 })
	expect(
		await meter.read({ resource: 'email_receives_per_day', day: dayN1 }),
	).toMatchObject({ outcome: 'needs_bootstrap' })

	const replay = await meter.consumeInboundDelivery({
		deliveryId: delivery.deliveryId,
		resource: 'email_receives_per_day',
		day: dayN1,
		limit: receiveLimit,
		updatedAt: `${dayN1}T00:01:00.000Z`,
	})
	expect(replay).toMatchObject({
		outcome: 'ready',
		consumed: false,
		replayed: true,
		count: 1,
		day: dayN,
		resource: 'email_receives_per_day',
	})

	const recovered = await chargeUserInboundDeliveryOnce({
		db: env.APP_DB,
		env,
		delivery: {
			...delivery,
			quotaDay: dayN1,
		},
		plan: 'free',
		limit: receiveLimit,
		now: new Date(`${dayN1}T00:01:00.000Z`),
		waitUntil: drain.waitUntil,
	})
	expect(recovered.deliveryId).toBe(delivery.deliveryId)
	await drain.drain()

	expect(
		await meter.read({ resource: 'email_receives_per_day', day: dayN }),
	).toMatchObject({ outcome: 'ready', count: 1 })
	expect(
		await meter.read({ resource: 'email_receives_per_day', day: dayN1 }),
	).toMatchObject({ outcome: 'needs_bootstrap' })

	const mirroredDayN = await env.APP_DB.prepare(
		`SELECT count FROM entitlement_daily_counters
		WHERE user_id = ? AND resource = 'email_receives_per_day' AND day = ?`,
	)
		.bind(userId, dayN)
		.first<{ count: number }>()
	const mirroredDayN1 = await env.APP_DB.prepare(
		`SELECT count FROM entitlement_daily_counters
		WHERE user_id = ? AND resource = 'email_receives_per_day' AND day = ?`,
	)
		.bind(userId, dayN1)
		.first<{ count: number }>()
	expect(Number(mirroredDayN?.count ?? 0)).toBe(1)
	expect(mirroredDayN1).toBeNull()
}, 30_000)
