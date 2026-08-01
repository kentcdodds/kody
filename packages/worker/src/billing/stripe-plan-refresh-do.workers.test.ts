import { expect, test, vi } from 'vitest'
import { env, runInDurableObject } from 'cloudflare:test'
import { ensureEntitlementTestSchema } from '#worker/entitlements/test-schema.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import {
	scheduleStripePlanRefreshBackstop,
	stripePlanRefreshBackstopDelayMs,
} from './stripe-plan-refresh-client.ts'

test('plan-relevant activity arms a per-user alarm that refreshes Stripe once', async () => {
	await ensureEntitlementTestSchema(env.APP_DB)
	const email = `stripe-alarm-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	await env.APP_DB.prepare(
		`INSERT INTO users (
			username, email, password_hash, email_verified_at, stable_user_id,
			plan, stripe_customer_id, stripe_plan, stripe_plan_refreshed_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			`stripe-alarm-${crypto.randomUUID().slice(0, 8)}`,
			email,
			'test-password-hash',
			new Date().toISOString(),
			userId,
			'free',
			'cus_alarm',
			null,
			null,
		)
		.run()
	const now = new Date('2026-08-01T06:00:00.000Z')
	const stub = env.STRIPE_PLAN_REFRESH.get(
		env.STRIPE_PLAN_REFRESH.idFromName(userId),
	)

	const scheduledBetween = Date.now()
	await expect(
		scheduleStripePlanRefreshBackstop({ env, userId, now }),
	).resolves.toBe(true)
	const alarmAt = await runInDurableObject(stub, async (_instance, state) =>
		state.storage.getAlarm(),
	)
	expect(alarmAt).toBeTypeOf('number')
	expect(alarmAt).toBeGreaterThanOrEqual(
		scheduledBetween + stripePlanRefreshBackstopDelayMs,
	)
	expect(alarmAt).toBeLessThanOrEqual(
		Date.now() + stripePlanRefreshBackstopDelayMs,
	)

	const fetchStub = vi.fn(async () =>
		Response.json({
			data: [
				{
					id: 'sub_alarm',
					status: 'active',
					cancel_at: null,
					items: { data: [{ price: { id: 'price_pro' } }] },
				},
			],
		}),
	)
	vi.stubGlobal('fetch', fetchStub)

	await runInDurableObject(stub, async (instance, state) => {
		await state.storage.deleteAlarm()
		await instance.alarm()
	})

	const row = await env.APP_DB.prepare(
		`SELECT stripe_plan, stripe_plan_refreshed_at
		 FROM users
		 WHERE stable_user_id = ?`,
	)
		.bind(userId)
		.first<{
			stripe_plan: string | null
			stripe_plan_refreshed_at: string | null
		}>()
	expect(row?.stripe_plan).toBe('pro')
	expect(row?.stripe_plan_refreshed_at).toBeTruthy()
	expect(fetchStub).toHaveBeenCalledTimes(1)
	expect(
		await runInDurableObject(stub, async (_instance, state) =>
			state.storage.getAlarm(),
		),
	).toBeNull()

	vi.unstubAllGlobals()
})

test('refresh failures re-arm, while account deletion prevents re-arming after purge', async () => {
	await ensureEntitlementTestSchema(env.APP_DB)
	const email = `stripe-alarm-retry-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	await env.APP_DB.prepare(
		`INSERT INTO users (
			username, email, password_hash, email_verified_at, stable_user_id,
			plan, stripe_customer_id, stripe_plan, stripe_plan_refreshed_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			`stripe-alarm-retry-${crypto.randomUUID().slice(0, 8)}`,
			email,
			'test-password-hash',
			new Date().toISOString(),
			userId,
			'free',
			'cus_alarm_retry',
			null,
			null,
		)
		.run()
	const stub = env.STRIPE_PLAN_REFRESH.get(
		env.STRIPE_PLAN_REFRESH.idFromName(userId),
	)
	await scheduleStripePlanRefreshBackstop({ env, userId })
	consoleError.mockImplementation(() => {})
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => Response.json({ error: 'stripe down' }, { status: 500 })),
	)

	const retryScheduledAfter = Date.now()
	await runInDurableObject(stub, async (instance, state) => {
		await state.storage.deleteAlarm()
		await instance.alarm()
	})
	const retryAlarm = await runInDurableObject(stub, async (_instance, state) =>
		state.storage.getAlarm(),
	)
	expect(retryAlarm).toBeGreaterThanOrEqual(
		retryScheduledAfter + stripePlanRefreshBackstopDelayMs,
	)
	expect(consoleError).toHaveBeenCalledWith(
		'stripe_plan_refresh_alarm_failed',
		expect.objectContaining({ userId, error: expect.any(Error) }),
	)

	await stub.purgeUser({ userId })
	await env.APP_DB.prepare(
		`UPDATE users SET deleting_at = ? WHERE stable_user_id = ?`,
	)
		.bind(new Date().toISOString(), userId)
		.run()
	await expect(
		scheduleStripePlanRefreshBackstop({ env, userId }),
	).resolves.toBe(false)
	expect(
		await runInDurableObject(stub, async (_instance, state) =>
			state.storage.getAlarm(),
		),
	).toBeNull()

	vi.unstubAllGlobals()
})
