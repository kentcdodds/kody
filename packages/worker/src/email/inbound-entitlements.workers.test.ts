import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import {
	nullPlanEmailFallbackLimits,
	planLimits,
} from '#worker/entitlements/plans.ts'
import {
	findUserAccountByStableUserId,
	utcDayKey,
} from '#worker/entitlements/service.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import {
	getEmailDomain,
	getEmailLocalPart,
	requireNormalizedEmailAddress,
} from './address.ts'
import { handleInboundEmail } from './inbound.ts'
import {
	createEmailInbox,
	createEmailInboxAddress,
	listEmailMessages,
	maxDetailedEmailRejectionEventsPerDay,
} from './repo.ts'
import { createForwardableEmailMessage } from './test-fixtures.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

async function seedAccountWithPlan(input: {
	email: string
	plan: 'personal' | null
	emailVerifiedAt?: string | null
}) {
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, email_verified_at, plan)
			VALUES (?, ?, ?, ?, ?)`,
	)
		.bind(
			`inbound-entitlement-${crypto.randomUUID().slice(0, 8)}`,
			input.email,
			'test-password-hash',
			input.emailVerifiedAt === undefined
				? new Date().toISOString()
				: input.emailVerifiedAt,
			input.plan,
		)
		.run()
}

async function seedInboxWithAddress(userId: string) {
	const address = requireNormalizedEmailAddress(
		`inbox-${crypto.randomUUID()}@example.com`,
	)
	const inbox = await createEmailInbox({
		db: env.APP_DB,
		userId,
		name: 'Entitlement inbox',
		description: 'Entitlement test inbox',
	})
	await createEmailInboxAddress({
		db: env.APP_DB,
		inboxId: inbox.id,
		userId,
		address,
		localPart: getEmailLocalPart(address),
		domain: getEmailDomain(address),
	})
	return { inbox, address }
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

test('inbound email rejects plan users at the daily receive limit', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const email = `receive-limit-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	const limit = planLimits.personal.maxEmailReceivesPerDay
	if (limit === null) throw new Error('Expected a numeric personal limit.')
	await seedAccountWithPlan({ email, plan: 'personal' })
	const { address } = await seedInboxWithAddress(userId)
	await setDailyReceiveCounter(userId, limit)

	const message = buildInboundMessage(address)
	await handleInboundEmail(message, env)

	expect(message.rejectedReason).toBe('Recipient mailbox is over quota.')
	expect(
		await listEmailMessages({ db: env.APP_DB, userId, limit: 10 }),
	).toEqual([])
	expect(await readDailyReceiveCounter(userId)).toBe(limit)
	const rejections = await readRejectionEvents(userId)
	expect(rejections.detailed).toHaveLength(1)
	// The plan-specific wording proves the stable-id reverse lookup resolved
	// the account (the fallback message says "this deployment" instead).
	expect(rejections.detailed[0]?.detail).toMatchObject({
		phase: 'entitlement',
		reason: expect.stringContaining(
			`your "personal" plan allows at most ${limit} email receives per day`,
		),
	})
	expect(rejections.aggregate?.detail).toMatchObject({ count: 1 })
	expect(await readEmailReceivedRollup(userId)).toMatchObject({
		event_count: 1,
		error_count: 1,
	})
})

test('inbound email rejects plan users at the stored message cap and still counts the attempt', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const email = `storage-cap-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	const cap = planLimits.personal.maxStoredEmailMessages
	if (cap === null) throw new Error('Expected a numeric personal cap.')
	await seedAccountWithPlan({ email, plan: 'personal' })
	const { address } = await seedInboxWithAddress(userId)
	await bulkInsertStoredMessages(userId, cap)

	const message = buildInboundMessage(address)
	await handleInboundEmail(message, env)

	expect(message.rejectedReason).toBe('Recipient mailbox is over quota.')
	expect(
		await listEmailMessages({ db: env.APP_DB, userId, limit: cap + 10 }),
	).toHaveLength(cap)
	// The receive attempt is counted even when the storage cap rejects it.
	expect(await readDailyReceiveCounter(userId)).toBe(1)
	const rejections = await readRejectionEvents(userId)
	expect(rejections.detailed[0]?.detail).toMatchObject({
		phase: 'entitlement',
		reason: expect.stringContaining(
			`your "personal" plan allows at most ${cap} stored email messages`,
		),
	})
})

test('inbound email applies the NULL-plan fallback receive limit', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	// A verified account with a NULL plan gets the deployment fallback.
	const email = `fallback-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	await seedAccountWithPlan({ email, plan: null })
	const fallbackLimit = nullPlanEmailFallbackLimits.email_receives_per_day
	const { address } = await seedInboxWithAddress(userId)
	await setDailyReceiveCounter(userId, fallbackLimit)

	const message = buildInboundMessage(address)
	await handleInboundEmail(message, env)

	expect(message.rejectedReason).toBe('Recipient mailbox is over quota.')
	const rejections = await readRejectionEvents(userId)
	expect(rejections.detailed[0]?.detail).toMatchObject({
		reason: expect.stringContaining(
			`this deployment allows at most ${fallbackLimit} email receives per day`,
		),
	})
})

test('inbound email rejects oversize messages without consuming the daily receive quota', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const email = `oversize-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	const maxBytes = planLimits.personal.maxEmailMessageBytes
	if (maxBytes === null) throw new Error('Expected a numeric size cap.')
	await seedAccountWithPlan({ email, plan: 'personal' })
	const { address } = await seedInboxWithAddress(userId)

	const message = buildInboundMessage(address)
	const oversizeBytes = maxBytes + 1
	Object.defineProperty(message, 'rawSize', { value: oversizeBytes })
	await handleInboundEmail(message, env)

	expect(message.rejectedReason).toBe('Recipient mailbox is over quota.')
	expect(
		await listEmailMessages({ db: env.APP_DB, userId, limit: 10 }),
	).toEqual([])
	// Oversize mail is rejected before the daily counter is consumed.
	expect(await readDailyReceiveCounter(userId)).toBe(0)
	const rejections = await readRejectionEvents(userId)
	expect(rejections.detailed[0]?.detail).toMatchObject({
		phase: 'size',
		reason: expect.stringContaining(
			`your "personal" plan allows at most ${maxBytes} bytes per email message`,
		),
	})
	// The usage event records the rejected size in bytes.
	expect(await readEmailReceivedRollup(userId)).toMatchObject({
		event_count: 1,
		error_count: 1,
		total_bytes: oversizeBytes,
	})
})

test('inbound email stores at most five detailed rejection events per inbox per day', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const email = `rejection-bound-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	const limit = planLimits.personal.maxEmailReceivesPerDay
	if (limit === null) throw new Error('Expected a numeric personal limit.')
	await seedAccountWithPlan({ email, plan: 'personal' })
	const { address } = await seedInboxWithAddress(userId)
	await setDailyReceiveCounter(userId, limit)

	const attempts = maxDetailedEmailRejectionEventsPerDay + 3
	for (let index = 0; index < attempts; index += 1) {
		const message = buildInboundMessage(address)
		await handleInboundEmail(message, env)
		expect(message.rejectedReason).toBe('Recipient mailbox is over quota.')
	}

	const rejections = await readRejectionEvents(userId)
	// Detailed rows are capped; the aggregate row counts every attempt.
	expect(rejections.detailed).toHaveLength(
		maxDetailedEmailRejectionEventsPerDay,
	)
	expect(rejections.aggregate?.detail).toMatchObject({
		aggregate: true,
		count: attempts,
		last_phase: 'entitlement',
		last_reason: expect.stringContaining('email receives per day'),
	})
	// Every attempt is still metered even after detailed events stop.
	expect(await readEmailReceivedRollup(userId)).toMatchObject({
		event_count: attempts,
		error_count: attempts,
	})
})

test('findUserAccountByStableUserId resolves accounts, caches hits, and recovers from deletions', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const email = `reverse-lookup-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	await seedAccountWithPlan({ email, plan: 'personal' })

	expect(await findUserAccountByStableUserId(env.APP_DB, userId)).toEqual({
		email,
		plan: 'personal',
		emailVerified: true,
	})
	// Second call takes the cached-email point-read path and must still
	// reflect the current plan and verified state.
	await env.APP_DB.prepare(
		`UPDATE users SET plan = NULL, email_verified_at = NULL WHERE email = ?`,
	)
		.bind(email)
		.run()
	expect(await findUserAccountByStableUserId(env.APP_DB, userId)).toEqual({
		email,
		plan: null,
		emailVerified: false,
	})
	// Deleting the account invalidates the cached entry.
	await env.APP_DB.prepare(`DELETE FROM users WHERE email = ?`)
		.bind(email)
		.run()
	expect(await findUserAccountByStableUserId(env.APP_DB, userId)).toBeNull()
	expect(
		await findUserAccountByStableUserId(env.APP_DB, `unknown-${userId}`),
	).toBeNull()
	expect(await findUserAccountByStableUserId(env.APP_DB, '  ')).toBeNull()
})

test('inbound email rejects unverified accounts without consuming quota, with bounded events', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const email = `unverified-quota-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	await seedAccountWithPlan({ email, plan: 'personal', emailVerifiedAt: null })
	const { address } = await seedInboxWithAddress(userId)

	for (let index = 0; index < 2; index += 1) {
		const message = buildInboundMessage(address)
		await handleInboundEmail(message, env)
		expect(message.rejectedReason).toBe('Account email is not verified.')
	}

	expect(
		await listEmailMessages({ db: env.APP_DB, userId, limit: 10 }),
	).toEqual([])
	// An account that can never receive must not accumulate receive quota.
	expect(await readDailyReceiveCounter(userId)).toBe(0)
	const rejections = await readRejectionEvents(userId)
	expect(rejections.detailed).toHaveLength(2)
	expect(rejections.detailed[0]?.detail).toMatchObject({
		phase: 'account-verification',
		reason: 'Account email is not verified.',
	})
	expect(rejections.aggregate?.detail).toMatchObject({
		count: 2,
		last_phase: 'account-verification',
	})
	// Attempts are still metered for owner visibility.
	expect(await readEmailReceivedRollup(userId)).toMatchObject({
		event_count: 2,
		error_count: 2,
	})
})

test('inbound email under quota stores the message, counts the receive, and records usage', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const email = `under-quota-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	await seedAccountWithPlan({ email, plan: 'personal' })
	const { address } = await seedInboxWithAddress(userId)

	const message = buildInboundMessage(address)
	await handleInboundEmail(message, env)

	expect(message.rejectedReason).toBeNull()
	const messages = await listEmailMessages({
		db: env.APP_DB,
		userId,
		limit: 10,
	})
	expect(messages).toHaveLength(1)
	expect(await readDailyReceiveCounter(userId)).toBe(1)
	expect(await readEmailReceivedRollup(userId)).toMatchObject({
		event_count: 1,
		error_count: 0,
		total_bytes: message.rawSize,
	})
})
