import { env } from 'cloudflare:test'
import { expect, test, vi } from 'vitest'
import { utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import {
	grantAdminCreditsToUser,
	loadAdminCreditWallet,
	setAdminCreditEligibility,
} from '#worker/admin/credit-grants.ts'
import { updateAdminUserPlan } from '#worker/admin/users-data.ts'
import { ensureRbacTestSchema } from '#worker/test-support/workers-seed.ts'
import {
	consumeDailyEntitlement,
	getUserEntitlement,
	resolveBaseUserEntitlement,
} from '#worker/entitlements/service.ts'
import { resolvePlanLimit } from '#universal/plans.ts'
import { loadAccountCreditsUser } from '#app/account-credits-data.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { runCreditAutoRefill } from './credit-auto-refill.ts'
import { runCreditDebits, settleCreditDebitMonth } from './credit-debits.ts'
import {
	applyCreditPayment,
	ensureCreditWallet,
	readCreditWallet,
	updateCreditWalletSettings,
} from './credit-wallet.ts'
import { ensureCreditWalletTestSchema } from './test-schema.ts'

const now = new Date('2026-09-27T12:00:00.000Z')
const month = utcMonthKey(now)

async function seedUser(input: {
	label: string
	plan?: string
	stripePlan?: string | null
	creditsEligible?: boolean
	stripeCustomerId?: string | null
}) {
	await ensureCreditWalletTestSchema(env.APP_DB)
	const email = `${input.label}-${crypto.randomUUID()}@example.com`
	const stableUserId = await createStableUserIdFromEmail(email)
	await env.APP_DB.prepare(
		`INSERT INTO users (
			username, email, password_hash, email_verified_at, stable_user_id, plan,
			stripe_customer_id, stripe_plan, stripe_credits_eligible
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			`${input.label}-${crypto.randomUUID().slice(0, 8)}`,
			email,
			'test-password-hash',
			now.toISOString(),
			stableUserId,
			input.plan ?? 'free',
			input.stripeCustomerId ?? null,
			input.stripePlan ?? null,
			input.creditsEligible ? 1 : 0,
		)
		.run()
	return { email, stableUserId }
}

async function setRollup(input: {
	userId: string
	metric: 'dynamic_worker_day' | 'durable_object_rows_read'
	count: number
	month?: string
}) {
	await env.APP_DB.prepare(
		`INSERT INTO usage_rollups (user_id, metric, month, event_count)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT (user_id, metric, month) DO UPDATE SET event_count = excluded.event_count`,
	)
		.bind(input.userId, input.metric, input.month ?? month, input.count)
		.run()
}

async function entitlementFor(user: { email: string; stableUserId: string }) {
	return getUserEntitlement(env.APP_DB, {
		userId: user.stableUserId,
		email: user.email,
	})
}

async function topUp(input: {
	userId: string
	cents: number
	reference?: string
}) {
	return applyCreditPayment({
		db: env.APP_DB,
		userId: input.userId,
		kind: 'top_up',
		amountCents: input.cents,
		stripeReference: input.reference ?? `cs_${crypto.randomUUID()}`,
		paymentMethodId: 'pm_saved',
		now,
	})
}

test('wallet eligibility: only the purchasable Pro gets a wallet; retired plans and Free never unlock', async () => {
	const pro = await seedUser({
		label: 'credits-pro',
		stripePlan: 'pro',
		creditsEligible: true,
	})
	const retiredStandard = await seedUser({
		label: 'credits-retired-standard',
		stripePlan: 'standard',
	})
	const retiredPro = await seedUser({
		label: 'credits-retired-pro',
		stripePlan: 'pro',
	})
	const free = await seedUser({ label: 'credits-free' })
	const manualMax = await seedUser({
		label: 'credits-max',
		plan: 'max',
		stripePlan: 'pro',
		creditsEligible: true,
	})

	for (const user of [pro, retiredStandard, retiredPro, free, manualMax]) {
		await topUp({ userId: user.stableUserId, cents: 1_000 })
	}

	expect((await entitlementFor(pro)).creditWallet).toBe('funded')
	for (const user of [retiredStandard, retiredPro, free, manualMax]) {
		expect((await entitlementFor(user)).creditWallet).toBe('none')
	}
	const retiredProEntitlement = await entitlementFor(retiredPro)
	expect(
		resolvePlanLimit(
			retiredProEntitlement.plan,
			'execute_calls_per_day',
			retiredProEntitlement.ladder,
			retiredProEntitlement.creditWallet,
		),
	).toBe(1_500)
})

test('balance > 0 unlocks 50Ã rate limits; debits to $0 re-block at the base cap', async () => {
	const user = await seedUser({
		label: 'credits-unlock',
		stripePlan: 'pro',
		creditsEligible: true,
	})
	expect((await entitlementFor(user)).creditWallet).toBe('empty')
	let entitlement = await entitlementFor(user)
	expect(
		resolvePlanLimit(
			entitlement.plan,
			'execute_calls_per_day',
			entitlement.ladder,
			entitlement.creditWallet,
		),
	).toBe(500)

	await ensureCreditWallet({
		db: env.APP_DB,
		userId: user.stableUserId,
		entitlement,
		now,
	})
	await topUp({ userId: user.stableUserId, cents: 1_000 })
	entitlement = await entitlementFor(user)
	expect(entitlement.creditWallet).toBe('funded')
	expect(
		resolvePlanLimit(
			entitlement.plan,
			'execute_calls_per_day',
			entitlement.ladder,
			entitlement.creditWallet,
		),
	).toBe(25_000)
	expect(
		resolvePlanLimit(
			entitlement.plan,
			'email_sends_per_day',
			entitlement.ladder,
			entitlement.creditWallet,
		),
	).toBe(200)
	await consumeDailyEntitlement({
		db: env.APP_DB,
		env,
		userId: user.stableUserId,
		email: user.email,
		resource: 'execute_calls_per_day',
		now,
	})

	// 350 included + 2,500 over at $0.004 = $10.00: balance hits exactly $0.
	await setRollup({
		userId: user.stableUserId,
		metric: 'dynamic_worker_day',
		count: 350 + 2_500,
	})
	await settleCreditDebitMonth({
		db: env.APP_DB,
		userId: user.stableUserId,
		entitlement,
		month,
		now,
	})
	expect(
		(await readCreditWallet(env.APP_DB, user.stableUserId)).balanceMicroUsd,
	).toBe(0)
	entitlement = await entitlementFor(user)
	expect(entitlement.creditWallet).toBe('empty')
	expect(
		resolvePlanLimit(
			entitlement.plan,
			'execute_calls_per_day',
			entitlement.ladder,
			entitlement.creditWallet,
		),
	).toBe(500)
})

test('debits charge only usage above the include, are idempotent, and never back-charge an empty wallet', async () => {
	const user = await seedUser({
		label: 'credits-debit',
		stripePlan: 'pro',
		creditsEligible: true,
	})
	const userId = user.stableUserId
	// Usage above the include before the wallet exists is never charged,
	// including the prior month the lane still settles.
	await setRollup({ userId, metric: 'dynamic_worker_day', count: 400 })
	await setRollup({
		userId,
		metric: 'dynamic_worker_day',
		count: 5_000,
		month: '2026-08',
	})
	await ensureCreditWallet({
		db: env.APP_DB,
		userId,
		entitlement: await entitlementFor(user),
		now,
	})
	await topUp({ userId, cents: 1_000 })

	await runCreditDebits({ env, now })
	expect((await readCreditWallet(env.APP_DB, userId)).balanceMicroUsd).toBe(
		10_000_000,
	)

	// +100 unique worker days and +10M rows above the include.
	await setRollup({ userId, metric: 'dynamic_worker_day', count: 500 })
	await setRollup({
		userId,
		metric: 'durable_object_rows_read',
		count: 5_000_000_000 + 10_000_000,
	})
	await runCreditDebits({ env, now })
	const expected = 10_000_000 - 100 * 4_000 - 10 * 2_000
	expect((await readCreditWallet(env.APP_DB, userId)).balanceMicroUsd).toBe(
		expected,
	)
	await runCreditDebits({ env, now })
	expect((await readCreditWallet(env.APP_DB, userId)).balanceMicroUsd).toBe(
		expected,
	)
	const debits = await env.APP_DB.prepare(
		`SELECT meter, units, amount_micro_usd FROM credit_ledger_entries
		 WHERE user_id = ? AND kind = 'debit' ORDER BY meter`,
	)
		.bind(userId)
		.all<{ meter: string; units: number; amount_micro_usd: number }>()
	expect(debits.results).toEqual([
		{
			meter: 'durable_object_rows_read',
			units: 10_000_000,
			amount_micro_usd: -20_000,
		},
		{ meter: 'unique_worker_days', units: 100, amount_micro_usd: -400_000 },
	])

	// Drain to $0, then usage while empty is forgiven, not owed.
	await env.APP_DB.prepare(
		`UPDATE credit_wallets SET balance_micro_usd = 0 WHERE user_id = ?`,
	)
		.bind(userId)
		.run()
	await setRollup({ userId, metric: 'dynamic_worker_day', count: 900 })
	await runCreditDebits({ env, now })
	expect((await readCreditWallet(env.APP_DB, userId)).balanceMicroUsd).toBe(0)
	await topUp({ userId, cents: 500 })
	await runCreditDebits({ env, now })
	expect((await readCreditWallet(env.APP_DB, userId)).balanceMicroUsd).toBe(
		5_000_000,
	)
})

test('retired plans with a balance are never debited', async () => {
	const user = await seedUser({
		label: 'credits-retired-debit',
		stripePlan: 'standard',
	})
	await topUp({ userId: user.stableUserId, cents: 1_000 })
	await setRollup({
		userId: user.stableUserId,
		metric: 'dynamic_worker_day',
		count: 5_000,
	})
	await runCreditDebits({ env, now })
	expect(
		(await readCreditWallet(env.APP_DB, user.stableUserId)).balanceMicroUsd,
	).toBe(10_000_000)
})

test('gift overlay usage above credits include is not back-charged on resubscribe', async () => {
	const user = await seedUser({
		label: 'credits-gift-resub',
		stripePlan: 'pro',
		creditsEligible: true,
	})
	await topUp({ userId: user.stableUserId, cents: 1_000 })
	await setRollup({
		userId: user.stableUserId,
		metric: 'dynamic_worker_day',
		count: 400,
	})
	await runCreditDebits({ env, now })
	const afterPaid = await readCreditWallet(env.APP_DB, user.stableUserId)
	// 400 − 350 = 50 billable days × $0.004 = 200_000 µUSD.
	expect(afterPaid.balanceMicroUsd).toBe(10_000_000 - 200_000)

	// Cancel purchasable Pro while a referral overlay is active.
	await env.APP_DB.prepare(
		`UPDATE users
		 SET stripe_plan = NULL, stripe_credits_eligible = 0,
		     referral_standard_credit_expires_at = ?
		 WHERE stable_user_id = ?`,
	)
		.bind('2099-01-01T00:00:00.000Z', user.stableUserId)
		.run()
	expect(await entitlementFor(user)).toEqual({
		plan: 'pro',
		ladder: 'public',
		creditWallet: 'none',
	})
	await setRollup({
		userId: user.stableUserId,
		metric: 'dynamic_worker_day',
		count: 600,
	})
	await runCreditDebits({ env, now })
	expect(
		(await readCreditWallet(env.APP_DB, user.stableUserId)).balanceMicroUsd,
	).toBe(afterPaid.balanceMicroUsd)

	// Resubscribe with the remaining funded balance: gift-period days
	// between 350 and 600 must stay forgiven.
	await env.APP_DB.prepare(
		`UPDATE users
		 SET stripe_plan = 'pro', stripe_credits_eligible = 1,
		     referral_standard_credit_expires_at = NULL
		 WHERE stable_user_id = ?`,
	)
		.bind(user.stableUserId)
		.run()
	expect(await entitlementFor(user)).toMatchObject({
		plan: 'pro',
		creditWallet: 'funded',
	})
	await runCreditDebits({ env, now })
	expect(
		(await readCreditWallet(env.APP_DB, user.stableUserId)).balanceMicroUsd,
	).toBe(afterPaid.balanceMicroUsd)
})

test('a replayed top-up credits once', async () => {
	const user = await seedUser({
		label: 'credits-replay',
		stripePlan: 'pro',
		creditsEligible: true,
	})
	const first = await topUp({
		userId: user.stableUserId,
		cents: 2_500,
		reference: 'cs_replay',
	})
	const replay = await topUp({
		userId: user.stableUserId,
		cents: 2_500,
		reference: 'cs_replay',
	})
	expect(first).toEqual({ applied: true, balanceMicroUsd: 25_000_000 })
	expect(replay).toEqual({ applied: false, balanceMicroUsd: 25_000_000 })
	expect(
		(await readCreditWallet(env.APP_DB, user.stableUserId))
			.autoRefillPaymentMethodId,
	).toBe('pm_saved')
})

test('admins can grant credits to any account, including themselves, with an audited ledger row', async () => {
	const admin = await seedUser({
		label: 'credits-admin',
		stripePlan: 'pro',
		creditsEligible: true,
	})
	const customer = await seedUser({ label: 'credits-grantee' })

	const self = await grantAdminCreditsToUser({
		env,
		target: { stableUserId: admin.stableUserId },
		grantedBy: { stableUserId: admin.stableUserId, email: admin.email },
		amountCents: 5_000,
		note: 'Top off owner wallet',
		path: '/admin/users/credits.json',
		now,
	})
	expect(self.wallet).toMatchObject({
		stableUserId: admin.stableUserId,
		eligible: true,
		unlocked: true,
		balanceMicroUsd: 50_000_000,
	})
	expect(self.wallet.recent[0]).toMatchObject({
		kind: 'admin_grant',
		amountMicroUsd: 50_000_000,
		note: 'Top off owner wallet',
		createdAt: now.toISOString(),
	})
	expect(self.wallet.recent[0]?.grantedByUsername).toMatch(/^credits-admin-/)

	const other = await grantAdminCreditsToUser({
		env,
		target: { email: customer.email },
		grantedBy: { stableUserId: admin.stableUserId, email: admin.email },
		amountCents: 1_000,
		note: undefined,
		path: '/mcp',
		audit: false,
		now,
	})
	expect(other.wallet).toMatchObject({
		eligible: false,
		unlocked: false,
		balanceMicroUsd: 10_000_000,
	})
	const row = await env.APP_DB.prepare(
		`SELECT user_id, granted_by_user_id, note, amount_micro_usd
		 FROM credit_ledger_entries WHERE id = ?`,
	)
		.bind(other.entryId)
		.first()
	expect(row).toEqual({
		user_id: customer.stableUserId,
		granted_by_user_id: admin.stableUserId,
		note: null,
		amount_micro_usd: 10_000_000,
	})

	await expect(
		grantAdminCreditsToUser({
			env,
			target: { stableUserId: customer.stableUserId },
			grantedBy: { stableUserId: admin.stableUserId, email: admin.email },
			amountCents: 0,
			note: null,
			path: '/mcp',
			now,
		}),
	).rejects.toMatchObject({ status: 400 })
	expect(
		(await loadAdminCreditWallet(env, { stableUserId: customer.stableUserId }))
			?.balanceMicroUsd,
	).toBe(10_000_000)
})

test('admin eligibility unlocks a manual Pro wallet without Stripe, survives Stripe refreshes, and clearing it holds the balance', async () => {
	const admin = await seedUser({ label: 'credits-eligibility-admin' })
	const user = await seedUser({ label: 'credits-manual-pro', plan: 'pro' })
	const userId = user.stableUserId
	const executeLimit = async () => {
		const entitlement = await entitlementFor(user)
		return resolvePlanLimit(
			entitlement.plan,
			'execute_calls_per_day',
			entitlement.ladder,
			entitlement.creditWallet,
		)
	}
	// Usage above the Pro include while the wallet was locked.
	await setRollup({ userId, metric: 'dynamic_worker_day', count: 900 })
	const granted = await grantAdminCreditsToUser({
		env,
		target: { stableUserId: userId },
		grantedBy: { stableUserId: admin.stableUserId, email: admin.email },
		amountCents: 100_000,
		note: undefined,
		path: '/mcp',
		audit: false,
		now,
	})
	expect(granted.wallet).toMatchObject({
		plan: 'pro',
		eligible: false,
		adminCreditsEligible: false,
		unlocked: false,
		balanceMicroUsd: 1_000_000_000,
	})
	expect((await entitlementFor(user)).creditWallet).toBe('none')
	// Without a wallet, manual Pro keeps the retired Pro table.
	expect(await executeLimit()).toBe(1_500)

	const enabled = await setAdminCreditEligibility({
		env,
		target: { username: granted.wallet.username },
		creditsEligible: true,
		note: 'Manual Pro wallet',
		now,
	})
	expect(enabled.previousAdminCreditsEligible).toBe(false)
	expect(enabled.note).toBe('Manual Pro wallet')
	expect(enabled.wallet).toMatchObject({
		plan: 'pro',
		eligible: true,
		adminCreditsEligible: true,
		unlocked: true,
		balanceMicroUsd: 1_000_000_000,
	})
	expect((await entitlementFor(user)).creditWallet).toBe('funded')
	expect(await executeLimit()).toBe(25_000)

	// Usage from before eligibility is not charged; new usage is.
	await runCreditDebits({ env, now })
	expect((await readCreditWallet(env.APP_DB, userId)).balanceMicroUsd).toBe(
		1_000_000_000,
	)
	await setRollup({ userId, metric: 'dynamic_worker_day', count: 1_000 })
	await runCreditDebits({ env, now })
	expect((await readCreditWallet(env.APP_DB, userId)).balanceMicroUsd).toBe(
		1_000_000_000 - 100 * 4_000,
	)

	// A Stripe refresh rewrites only the Stripe projection.
	await env.APP_DB.prepare(
		`UPDATE users SET stripe_credits_eligible = 0 WHERE stable_user_id = ?`,
	)
		.bind(userId)
		.run()
	expect((await entitlementFor(user)).creditWallet).toBe('funded')
	const stripeColumns = await env.APP_DB.prepare(
		`SELECT id, stripe_customer_id, stripe_plan, stripe_price_id
		 FROM users WHERE stable_user_id = ?`,
	)
		.bind(userId)
		.first<{
			id: number
			stripe_customer_id: string | null
			stripe_plan: string | null
			stripe_price_id: string | null
		}>()
	expect(stripeColumns).toMatchObject({
		stripe_customer_id: null,
		stripe_plan: null,
		stripe_price_id: null,
	})
	// Admin eligibility funds the wallet but never enables buying credits.
	expect(
		(
			await loadAccountCreditsUser({
				env,
				userId: stripeColumns?.id ?? 0,
				now,
			})
		)?.canBuyCredits,
	).toBe(false)

	const cleared = await setAdminCreditEligibility({
		env,
		target: { email: user.email },
		creditsEligible: false,
		note: undefined,
		now,
	})
	expect(cleared.previousAdminCreditsEligible).toBe(true)
	expect(cleared.wallet).toMatchObject({
		eligible: false,
		adminCreditsEligible: false,
		unlocked: false,
		balanceMicroUsd: 1_000_000_000 - 100 * 4_000,
	})
	expect((await entitlementFor(user)).creditWallet).toBe('none')
	expect(await executeLimit()).toBe(1_500)
	await setRollup({ userId, metric: 'dynamic_worker_day', count: 2_000 })
	await runCreditDebits({ env, now })
	expect((await readCreditWallet(env.APP_DB, userId)).balanceMicroUsd).toBe(
		1_000_000_000 - 100 * 4_000,
	)
})

test('granting manual Pro after admin eligibility still forgives locked-period usage', async () => {
	const user = await seedUser({ label: 'credits-eligible-then-pro' })
	await ensureRbacTestSchema(env.APP_DB)
	const userId = user.stableUserId
	await topUp({ userId, cents: 1_000 })
	await setRollup({ userId, metric: 'dynamic_worker_day', count: 900 })
	const enabled = await setAdminCreditEligibility({
		env,
		target: { stableUserId: userId },
		creditsEligible: true,
		note: null,
		now,
	})
	expect(enabled.wallet).toMatchObject({
		plan: 'free',
		eligible: false,
		adminCreditsEligible: true,
	})
	await updateAdminUserPlan(env.APP_DB, {
		stableUserId: userId,
		plan: 'pro',
		now,
	})
	expect((await entitlementFor(user)).creditWallet).toBe('funded')
	await runCreditDebits({ env, now })
	expect((await readCreditWallet(env.APP_DB, userId)).balanceMicroUsd).toBe(
		10_000_000,
	)
	await setRollup({ userId, metric: 'dynamic_worker_day', count: 1_000 })
	await runCreditDebits({ env, now })
	expect((await readCreditWallet(env.APP_DB, userId)).balanceMicroUsd).toBe(
		10_000_000 - 100 * 4_000,
	)
})

test('admin eligibility does not unlock a wallet outside an effective Pro plan', async () => {
	const manualMax = await seedUser({
		label: 'credits-eligible-max',
		plan: 'max',
	})
	const free = await seedUser({ label: 'credits-eligible-free' })
	for (const user of [manualMax, free]) {
		await topUp({ userId: user.stableUserId, cents: 1_000 })
		const result = await setAdminCreditEligibility({
			env,
			target: { stableUserId: user.stableUserId },
			creditsEligible: true,
			note: null,
			now,
		})
		expect(result.wallet).toMatchObject({
			eligible: false,
			adminCreditsEligible: true,
			unlocked: false,
		})
		expect((await entitlementFor(user)).creditWallet).toBe('none')
	}
	await expect(
		setAdminCreditEligibility({
			env,
			target: { username: `missing-${crypto.randomUUID()}` },
			creditsEligible: true,
			note: null,
			now,
		}),
	).rejects.toMatchObject({ status: 404 })
})

test('auto-refill charges the saved card at the threshold and stops at the monthly cap', async () => {
	const user = await seedUser({
		label: 'credits-refill',
		stripePlan: 'pro',
		creditsEligible: true,
		stripeCustomerId: `cus_${crypto.randomUUID().slice(0, 8)}`,
	})
	const userId = user.stableUserId
	await ensureCreditWallet({
		db: env.APP_DB,
		userId,
		entitlement: await entitlementFor(user),
		now,
	})
	await topUp({ userId, cents: 500 })
	await env.APP_DB.prepare(
		`UPDATE credit_wallets SET balance_micro_usd = 0 WHERE user_id = ?`,
	)
		.bind(userId)
		.run()
	await updateCreditWalletSettings({
		db: env.APP_DB,
		userId,
		autoRefill: {
			enabled: true,
			thresholdCents: 500,
			amountCents: 1_000,
			monthlyCapCents: 1_500,
		},
		notify: { autoRefilled: false, monthlyCap: false, lowBalance: false },
		now,
	})
	const stripeEnv = {
		...env,
		STRIPE_SECRET_KEY: 'sk_test_secret',
		STRIPE_API_BASE_URL: 'https://stripe.mock',
	} as Env
	const fetchMock = vi.fn(async () =>
		Response.json({
			id: `pi_${crypto.randomUUID().slice(0, 8)}`,
			status: 'succeeded',
			amount: 1_000,
			currency: 'usd',
		}),
	)
	vi.stubGlobal('fetch', fetchMock)
	try {
		const charged = await runCreditAutoRefill({
			env: stripeEnv,
			userId,
			email: user.email,
			stripeCustomerId:
				(
					await env.APP_DB.prepare(
						`SELECT stripe_customer_id FROM users WHERE stable_user_id = ?`,
					)
						.bind(userId)
						.first<{ stripe_customer_id: string }>()
				)?.stripe_customer_id ?? null,
			now,
		})
		expect(charged).toBe('charged')
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect((await readCreditWallet(env.APP_DB, userId)).balanceMicroUsd).toBe(
			10_000_000,
		)

		// Above the threshold: nothing to do.
		expect(
			await runCreditAutoRefill({
				env: stripeEnv,
				userId,
				email: user.email,
				stripeCustomerId: 'cus_any',
				now,
			}),
		).toBe('skipped')

		// Back under the threshold, but another $10 would pass the $15 cap.
		await env.APP_DB.prepare(
			`UPDATE credit_wallets SET balance_micro_usd = 0 WHERE user_id = ?`,
		)
			.bind(userId)
			.run()
		expect(
			await runCreditAutoRefill({
				env: stripeEnv,
				userId,
				email: user.email,
				stripeCustomerId: 'cus_any',
				now,
			}),
		).toBe('cap_reached')
		expect(fetchMock).toHaveBeenCalledTimes(1)
	} finally {
		vi.unstubAllGlobals()
	}
})

test('funding an empty wallet forgives usage from before the top-up', async () => {
	const user = await seedUser({
		label: 'credits-refund-gap',
		stripePlan: 'pro',
		creditsEligible: true,
	})
	const userId = user.stableUserId
	await ensureCreditWallet({
		db: env.APP_DB,
		userId,
		entitlement: await entitlementFor(user),
		now,
	})
	// Usage grows above the include while the wallet is empty, between
	// sweeps; the top-up lands before the next sweep.
	await setRollup({ userId, metric: 'dynamic_worker_day', count: 450 })
	await topUp({ userId, cents: 1_000 })
	await runCreditDebits({ env, now })
	expect((await readCreditWallet(env.APP_DB, userId)).balanceMicroUsd).toBe(
		10_000_000,
	)
	// Usage after the top-up is debited.
	await setRollup({ userId, metric: 'dynamic_worker_day', count: 460 })
	await runCreditDebits({ env, now })
	expect((await readCreditWallet(env.APP_DB, userId)).balanceMicroUsd).toBe(
		10_000_000 - 10 * 4_000,
	)
})

test('the bounded debit sweep resumes from its cursor and wraps at the tail', async () => {
	const users = [
		await seedUser({
			label: 'credits-cursor-a',
			stripePlan: 'pro',
			creditsEligible: true,
		}),
		await seedUser({
			label: 'credits-cursor-b',
			stripePlan: 'pro',
			creditsEligible: true,
		}),
	]
	const [first, second] = [...users].sort((left, right) =>
		left.stableUserId.localeCompare(right.stableUserId),
	)
	if (!first || !second) throw new Error('Expected two users.')
	for (const user of [first, second]) {
		await ensureCreditWallet({
			db: env.APP_DB,
			userId: user.stableUserId,
			entitlement: await entitlementFor(user),
			now,
		})
		await topUp({ userId: user.stableUserId, cents: 1_000 })
		await setRollup({
			userId: user.stableUserId,
			metric: 'dynamic_worker_day',
			count: 351,
		})
	}
	// A previous bounded run stopped right after `first`.
	await env.APP_DB.prepare(
		`UPDATE credit_debit_cursor SET position = ? WHERE singleton = 1`,
	)
		.bind(first.stableUserId)
		.run()
	await runCreditDebits({ env, now })
	expect(
		(await readCreditWallet(env.APP_DB, second.stableUserId)).balanceMicroUsd,
	).toBe(10_000_000 - 4_000)
	expect(
		(await readCreditWallet(env.APP_DB, first.stableUserId)).balanceMicroUsd,
	).toBe(10_000_000)
	expect(
		await env.APP_DB.prepare(
			`SELECT position FROM credit_debit_cursor WHERE singleton = 1`,
		).first(),
	).toEqual({ position: '' })
	await runCreditDebits({ env, now })
	expect(
		(await readCreditWallet(env.APP_DB, first.stableUserId)).balanceMicroUsd,
	).toBe(10_000_000 - 4_000)
})

test('gift and referral Pro overlays keep retired Pro ceilings without a wallet', async () => {
	const overlay = await seedUser({
		label: 'credits-overlay',
		stripeCustomerId: `cus_${crypto.randomUUID().slice(0, 8)}`,
	})
	await env.APP_DB.prepare(
		`UPDATE users SET referral_standard_credit_expires_at = ? WHERE stable_user_id = ?`,
	)
		.bind('2099-01-01T00:00:00.000Z', overlay.stableUserId)
		.run()
	const paying = await seedUser({
		label: 'credits-paying',
		stripePlan: 'pro',
		creditsEligible: true,
		stripeCustomerId: `cus_${crypto.randomUUID().slice(0, 8)}`,
	})
	const idFor = async (stableUserId: string) =>
		(
			await env.APP_DB.prepare(`SELECT id FROM users WHERE stable_user_id = ?`)
				.bind(stableUserId)
				.first<{ id: number }>()
		)?.id ?? 0
	const overlayUser = await loadAccountCreditsUser({
		env,
		userId: await idFor(overlay.stableUserId),
		now,
	})
	expect(overlayUser?.entitlement).toMatchObject({
		plan: 'pro',
		creditWallet: 'none',
	})
	expect(overlayUser?.canBuyCredits).toBe(false)
	const payingUser = await loadAccountCreditsUser({
		env,
		userId: await idFor(paying.stableUserId),
		now,
	})
	expect(payingUser?.canBuyCredits).toBe(true)
	expect(payingUser?.entitlement.creditWallet).toBe('empty')
})

test('saving credit settings before any top-up creates the wallet and keeps the settings', async () => {
	const user = await seedUser({
		label: 'credits-settings-first',
		stripePlan: 'pro',
		creditsEligible: true,
	})
	const userId = user.stableUserId
	const autoRefill = {
		enabled: true,
		thresholdCents: 500,
		amountCents: 1_000,
		monthlyCapCents: 5_000,
	}
	const saved = await updateCreditWalletSettings({
		db: env.APP_DB,
		userId,
		autoRefill,
		notify: { autoRefilled: false, monthlyCap: true, lowBalance: true },
		now,
	})
	expect(saved.autoRefill).toEqual(autoRefill)
	expect(saved.notify.autoRefilled).toBe(false)
	await topUp({ userId, cents: 1_000 })
	const wallet = await readCreditWallet(env.APP_DB, userId)
	expect(wallet.balanceMicroUsd).toBe(10_000_000)
	expect(wallet.autoRefill).toEqual(autoRefill)
})

test('base entitlement never pairs an overlay plan with Stripe-only eligibility', async () => {
	const overlay = await seedUser({ label: 'credits-base-overlay' })
	await env.APP_DB.prepare(
		`UPDATE users SET referral_standard_credit_expires_at = ? WHERE stable_user_id = ?`,
	)
		.bind('2099-01-01T00:00:00.000Z', overlay.stableUserId)
		.run()
	await topUp({ userId: overlay.stableUserId, cents: 1_000 })
	const paying = await seedUser({
		label: 'credits-base-paying',
		stripePlan: 'pro',
		creditsEligible: true,
	})
	await topUp({ userId: paying.stableUserId, cents: 1_000 })
	const retired = await seedUser({
		label: 'credits-base-retired',
		stripePlan: 'pro',
	})
	const rowFor = async (stableUserId: string) => {
		const row = await env.APP_DB.prepare(
			`SELECT plan, stripe_plan, entitlement_ladder, stripe_credits_eligible
			 FROM users WHERE stable_user_id = ?`,
		)
			.bind(stableUserId)
			.first<{
				plan: string
				stripe_plan: string | null
				entitlement_ladder: string | null
				stripe_credits_eligible: number
			}>()
		if (!row) throw new Error('Expected a user row.')
		return row
	}
	const base = async (stableUserId: string) =>
		resolveBaseUserEntitlement({
			db: env.APP_DB,
			stableUserId,
			row: await rowFor(stableUserId),
		})
	// Base plans ignore overlays entirely: Free, no wallet.
	expect(await base(overlay.stableUserId)).toEqual({
		plan: 'free',
		ladder: 'public',
		creditWallet: 'none',
	})
	expect(await base(paying.stableUserId)).toEqual({
		plan: 'pro',
		ladder: 'public',
		creditWallet: 'funded',
	})
	expect(await base(retired.stableUserId)).toEqual({
		plan: 'pro',
		ladder: 'public',
		creditWallet: 'none',
	})
	// Overlay-aware resolution grants Pro without a wallet (retired ceilings).
	expect(await entitlementFor(overlay)).toEqual({
		plan: 'pro',
		ladder: 'public',
		creditWallet: 'none',
	})
})
