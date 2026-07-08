import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import {
	nullPlanEmailFallbackLimits,
	planLimits,
} from '#worker/entitlements/plans.ts'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { handleInboundEmail } from './inbound.ts'
import {
	listEmailMessages,
	maxDetailedEmailRejectionEventsPerDay,
} from './repo.ts'
import { createForwardableEmailMessage } from './test-fixtures.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

const platformBaseUrl = 'https://kody.example.com'
// User mail lives on the inbox. subdomain derived from APP_BASE_URL.
const platformDomain = 'inbox.kody.example.com'

function createInboundEnv() {
	return { ...env, APP_BASE_URL: platformBaseUrl }
}

async function seedAccountWithPlan(input: {
	email: string
	plan: 'personal' | null
	emailVerifiedAt?: string | null
}) {
	const username = `quota-${crypto.randomUUID().slice(0, 8)}`
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, email_verified_at, plan)
			VALUES (?, ?, ?, ?, ?)`,
	)
		.bind(
			username,
			input.email,
			'test-password-hash',
			input.emailVerifiedAt === undefined
				? new Date().toISOString()
				: input.emailVerifiedAt,
			input.plan,
		)
		.run()
	return { username, address: `${username}@${platformDomain}` }
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

async function setDailyReceiveCounter(userId: string, count: number) {
	await env.APP_DB.prepare(
		`INSERT INTO entitlement_daily_counters (user_id, resource, day, count, updated_at)
			VALUES (?, 'email_receives_per_day', ?, ?, ?)`,
	)
		.bind(userId, utcDayKey(), count, new Date().toISOString())
		.run()
}

async function readDailyReceiveCounter(userId: string) {
	const row = await env.APP_DB.prepare(
		`SELECT count FROM entitlement_daily_counters
			WHERE user_id = ? AND resource = 'email_receives_per_day' AND day = ?`,
	)
		.bind(userId, utcDayKey())
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
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

test('inbound email enforces personal-plan receive, storage, and size limits then stores under quota', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)

	const receiveLimitEmail = `receive-limit-${crypto.randomUUID()}@example.com`
	const receiveLimitUserId =
		await createStableUserIdFromEmail(receiveLimitEmail)
	const receiveLimit = planLimits.personal.maxEmailReceivesPerDay
	if (receiveLimit === null)
		throw new Error('Expected a numeric personal limit.')
	const { address: receiveLimitAddress } = await seedAccountWithPlan({
		email: receiveLimitEmail,
		plan: 'personal',
	})
	await setDailyReceiveCounter(receiveLimitUserId, receiveLimit)

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

	const storageCapEmail = `storage-cap-${crypto.randomUUID()}@example.com`
	const storageCapUserId = await createStableUserIdFromEmail(storageCapEmail)
	const storageCap = planLimits.personal.maxStoredEmailMessages
	if (storageCap === null) throw new Error('Expected a numeric personal cap.')
	const { address: storageCapAddress } = await seedAccountWithPlan({
		email: storageCapEmail,
		plan: 'personal',
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
	expect(await readDailyReceiveCounter(storageCapUserId)).toBe(1)
	expect(
		(await readRejectionEvents(storageCapUserId)).detailed[0]?.detail,
	).toMatchObject({
		phase: 'entitlement',
	})

	const oversizeEmail = `oversize-${crypto.randomUUID()}@example.com`
	const oversizeUserId = await createStableUserIdFromEmail(oversizeEmail)
	const maxBytes = planLimits.personal.maxEmailMessageBytes
	if (maxBytes === null) throw new Error('Expected a numeric size cap.')
	const { address: oversizeAddress } = await seedAccountWithPlan({
		email: oversizeEmail,
		plan: 'personal',
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
		plan: 'personal',
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

test('inbound email applies the NULL-plan fallback receive limit', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const email = `fallback-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	const { address } = await seedAccountWithPlan({ email, plan: null })
	const fallbackLimit = nullPlanEmailFallbackLimits.email_receives_per_day
	await setDailyReceiveCounter(userId, fallbackLimit)

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
	const limit = planLimits.personal.maxEmailReceivesPerDay
	if (limit === null) throw new Error('Expected a numeric personal limit.')
	const { address } = await seedAccountWithPlan({ email, plan: 'personal' })
	await setDailyReceiveCounter(userId, limit)

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
