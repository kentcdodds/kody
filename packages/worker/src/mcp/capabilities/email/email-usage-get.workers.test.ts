import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { maxPlanEmailLimits, planLimits } from '#worker/entitlements/plans.ts'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { ensureEmailTestSchema } from '#worker/email/test-schema.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { emailUsageGetCapability } from './email-usage-get.ts'

async function seedUser(input: {
	email: string
	plan: 'pro' | 'max'
	emailVerifiedAt?: string | null
}) {
	const stableUserId = await createStableUserIdFromEmail(input.email)
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, email_verified_at, plan, stable_user_id)
			VALUES (?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			`email-usage-${crypto.randomUUID().slice(0, 8)}`,
			input.email,
			'test-password-hash',
			input.emailVerifiedAt === undefined
				? new Date().toISOString()
				: input.emailVerifiedAt,
			input.plan,
			stableUserId,
		)
		.run()
}

async function seedDailyCounter(input: {
	userId: string
	resource: 'email_sends_per_day' | 'email_receives_per_day'
	count: number
}) {
	await env.APP_DB.prepare(
		`INSERT INTO entitlement_daily_counters (user_id, resource, day, count, updated_at)
			VALUES (?, ?, ?, ?, ?)`,
	)
		.bind(
			input.userId,
			input.resource,
			utcDayKey(),
			input.count,
			new Date().toISOString(),
		)
		.run()
}

async function seedStoredMessages(userId: string, count: number) {
	const now = new Date().toISOString()
	for (let index = 0; index < count; index += 1) {
		await env.APP_DB.prepare(
			`INSERT INTO email_messages (
				id, direction, user_id, from_address, subject,
				processing_status, created_at, updated_at
			) VALUES (?, 'inbound', ?, 'sender@example.net', 'Stored', 'stored', ?, ?)`,
		)
			.bind(`usage-message-${crypto.randomUUID()}`, userId, now, now)
			.run()
	}
}

function buildCallerContext(user: { userId: string; email: string } | null) {
	return createMcpCallerContext({
		baseUrl: 'https://example.com',
		...(user ? { user: { ...user, displayName: 'Usage Tester' } } : {}),
	})
}

test('email_usage_get returns usage for verified users and enforces auth requirements', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await expect(
		emailUsageGetCapability.handler(
			{},
			{ env, callerContext: buildCallerContext(null) },
		),
	).rejects.toThrow(/Authenticated MCP user/)

	const unverifiedEmail = `usage-unverified-${crypto.randomUUID()}@example.com`
	const unverifiedUserId = await createStableUserIdFromEmail(unverifiedEmail)
	await seedUser({
		email: unverifiedEmail,
		plan: 'max',
		emailVerifiedAt: null,
	})
	await expect(
		emailUsageGetCapability.handler(
			{},
			{
				env,
				callerContext: buildCallerContext({
					userId: unverifiedUserId,
					email: unverifiedEmail,
				}),
			},
		),
	).rejects.toThrow(/Account email is not verified/)

	const planEmail = `usage-plan-${crypto.randomUUID()}@example.com`
	const planUserId = await createStableUserIdFromEmail(planEmail)
	await seedUser({ email: planEmail, plan: 'pro' })
	await seedDailyCounter({
		userId: planUserId,
		resource: 'email_sends_per_day',
		count: 3,
	})
	await seedDailyCounter({
		userId: planUserId,
		resource: 'email_receives_per_day',
		count: 5,
	})
	await seedStoredMessages(planUserId, 2)

	const planResult = await emailUsageGetCapability.handler(
		{},
		{
			env,
			callerContext: buildCallerContext({
				userId: planUserId,
				email: planEmail,
			}),
		},
	)
	expect(planResult).toEqual({
		plan: 'pro',
		day: utcDayKey(),
		stored_messages: {
			count: 2,
			limit: planLimits.pro.maxStoredEmailMessages,
		},
		sends_today: { count: 3, limit: planLimits.pro.maxEmailSendsPerDay },
		receives_today: {
			count: 5,
			limit: planLimits.pro.maxEmailReceivesPerDay,
		},
		max_message_bytes: planLimits.pro.maxEmailMessageBytes,
	})

	const maxEmail = `usage-max-${crypto.randomUUID()}@example.com`
	const maxUserId = await createStableUserIdFromEmail(maxEmail)
	await seedUser({ email: maxEmail, plan: 'max' })
	const maxResult = await emailUsageGetCapability.handler(
		{},
		{
			env,
			callerContext: buildCallerContext({
				userId: maxUserId,
				email: maxEmail,
			}),
		},
	)
	expect(maxResult).toEqual({
		plan: 'max',
		day: utcDayKey(),
		stored_messages: {
			count: 0,
			limit: maxPlanEmailLimits.stored_email_messages,
		},
		sends_today: {
			count: 0,
			limit: maxPlanEmailLimits.email_sends_per_day,
		},
		receives_today: {
			count: 0,
			limit: maxPlanEmailLimits.email_receives_per_day,
		},
		max_message_bytes: maxPlanEmailLimits.email_message_bytes,
	})
})
