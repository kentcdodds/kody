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
} from './repo.ts'
import { createForwardableEmailMessage } from './test-fixtures.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

async function seedAccountWithPlan(input: {
	email: string
	plan: 'personal' | null
}) {
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, email_verified_at, plan)
			VALUES (?, ?, ?, ?, ?)`,
	)
		.bind(
			`inbound-entitlement-${crypto.randomUUID().slice(0, 8)}`,
			input.email,
			'test-password-hash',
			new Date().toISOString(),
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

async function listRejectedDeliveryEvents(userId: string) {
	const { results } = await env.APP_DB.prepare(
		`SELECT event_type, detail_json FROM email_delivery_events
			WHERE user_id = ? AND event_type = 'rejected'
			ORDER BY created_at ASC`,
	)
		.bind(userId)
		.all<{ event_type: string; detail_json: string }>()
	return (results ?? []).map((row) => ({
		eventType: row.event_type,
		detail: JSON.parse(row.detail_json) as Record<string, unknown>,
	}))
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
	const rejections = await listRejectedDeliveryEvents(userId)
	expect(rejections).toHaveLength(1)
	// The plan-specific wording proves the stable-id reverse lookup resolved
	// the account (the fallback message says "this deployment" instead).
	expect(rejections[0]?.detail).toMatchObject({
		phase: 'entitlement',
		reason: expect.stringContaining(
			`your "personal" plan allows at most ${limit} email receives per day`,
		),
	})
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
	const rejections = await listRejectedDeliveryEvents(userId)
	expect(rejections[0]?.detail).toMatchObject({
		phase: 'entitlement',
		reason: expect.stringContaining(
			`your "personal" plan allows at most ${cap} stored email messages`,
		),
	})
})

test('inbound email applies the NULL-plan fallback receive limit', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	// No users row exists for this synthetic user id, so the plan lookup
	// resolves nothing and the deployment fallback applies.
	const userId = `inbound-fallback-${crypto.randomUUID()}`
	const fallbackLimit = nullPlanEmailFallbackLimits.email_receives_per_day
	const { address } = await seedInboxWithAddress(userId)
	await setDailyReceiveCounter(userId, fallbackLimit)

	const message = buildInboundMessage(address)
	await handleInboundEmail(message, env)

	expect(message.rejectedReason).toBe('Recipient mailbox is over quota.')
	const rejections = await listRejectedDeliveryEvents(userId)
	expect(rejections[0]?.detail).toMatchObject({
		reason: expect.stringContaining(
			`this deployment allows at most ${fallbackLimit} email receives per day`,
		),
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
	})
	// Second call takes the cached-email point-read path and must still
	// reflect the current plan value.
	await env.APP_DB.prepare(`UPDATE users SET plan = NULL WHERE email = ?`)
		.bind(email)
		.run()
	expect(await findUserAccountByStableUserId(env.APP_DB, userId)).toEqual({
		email,
		plan: null,
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
