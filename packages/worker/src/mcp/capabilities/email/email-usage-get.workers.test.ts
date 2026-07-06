import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	nullPlanEmailFallbackLimits,
	planLimits,
} from '#worker/entitlements/plans.ts'
import { utcDayKey } from '#worker/entitlements/service.ts'
import { ensureEmailTestSchema } from '#worker/email/test-schema.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { emailUsageGetCapability } from './email-usage-get.ts'

async function seedUser(input: {
	email: string
	plan: 'personal' | null
	emailVerifiedAt?: string | null
}) {
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, email_verified_at, plan)
			VALUES (?, ?, ?, ?, ?)`,
	)
		.bind(
			`email-usage-${crypto.randomUUID().slice(0, 8)}`,
			input.email,
			'test-password-hash',
			input.emailVerifiedAt === undefined
				? new Date().toISOString()
				: input.emailVerifiedAt,
			input.plan,
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

test('email_usage_get requires a signed-in, verified user', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await expect(
		emailUsageGetCapability.handler(
			{},
			{ env, callerContext: buildCallerContext(null) },
		),
	).rejects.toThrow(/Authenticated MCP user/)

	const email = `usage-unverified-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	await seedUser({ email, plan: null, emailVerifiedAt: null })
	await expect(
		emailUsageGetCapability.handler(
			{},
			{ env, callerContext: buildCallerContext({ userId, email }) },
		),
	).rejects.toThrow(/Account email is not verified/)
})

test('email_usage_get returns plan limits and current counts for plan users', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const email = `usage-plan-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	await seedUser({ email, plan: 'personal' })
	await seedDailyCounter({ userId, resource: 'email_sends_per_day', count: 3 })
	await seedDailyCounter({
		userId,
		resource: 'email_receives_per_day',
		count: 5,
	})
	await seedStoredMessages(userId, 2)

	const result = await emailUsageGetCapability.handler(
		{},
		{ env, callerContext: buildCallerContext({ userId, email }) },
	)

	expect(result).toEqual({
		plan: 'personal',
		day: utcDayKey(),
		stored_messages: {
			count: 2,
			limit: planLimits.personal.maxStoredEmailMessages,
		},
		sends_today: { count: 3, limit: planLimits.personal.maxEmailSendsPerDay },
		receives_today: {
			count: 5,
			limit: planLimits.personal.maxEmailReceivesPerDay,
		},
		max_message_bytes: planLimits.personal.maxEmailMessageBytes,
	})
})

test('email_usage_get reports fallback limits for users without a plan', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const email = `usage-null-plan-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	await seedUser({ email, plan: null })

	const result = await emailUsageGetCapability.handler(
		{},
		{ env, callerContext: buildCallerContext({ userId, email }) },
	)

	expect(result).toEqual({
		plan: null,
		day: utcDayKey(),
		stored_messages: {
			count: 0,
			limit: nullPlanEmailFallbackLimits.stored_email_messages,
		},
		// Outbound sends stay unlimited for plan-less users.
		sends_today: { count: 0, limit: null },
		receives_today: {
			count: 0,
			limit: nullPlanEmailFallbackLimits.email_receives_per_day,
		},
		max_message_bytes: nullPlanEmailFallbackLimits.email_message_bytes,
	})
})
