import { env } from 'cloudflare:test'
import { utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import { expect, test } from 'vitest'
import { creditDebitCostMicroUsd } from '#universal/credits.ts'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import {
	creditDebitBatchSize,
	creditDebitMaxBatchesPerRun,
	listCreditDebitCandidates,
	runCreditDebits,
} from './credit-debits.ts'
import { applyCreditPayment, readCreditWallet } from './credit-wallet.ts'
import { ensureCreditWalletTestSchema } from './test-schema.ts'

const now = new Date('2026-09-27T12:00:00.000Z')
const month = utcMonthKey(now)
const oneBillableDayMicroUsd =
	creditDebitCostMicroUsd('unique_worker_days', 1) -
	creditDebitCostMicroUsd('unique_worker_days', 0)

async function ensureSchema() {
	await ensureCreditWalletTestSchema(env.APP_DB)
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS usage_attribution_daily (
			user_id TEXT NOT NULL,
			day TEXT NOT NULL,
			package_id TEXT NOT NULL,
			meter TEXT NOT NULL,
			units REAL NOT NULL DEFAULT 0,
			actor_user_id TEXT,
			automation_source TEXT,
			PRIMARY KEY (user_id, day, package_id, meter)
		)`,
	).run()
}

async function seedPersonalPro(label: string, stripeCustomerId: string) {
	await ensureSchema()
	const email = `${label}-${crypto.randomUUID()}@example.com`
	const stableUserId = testStableUserIdFromEmail(email)
	await env.APP_DB.prepare(
		`INSERT INTO users (
			username, email, password_hash, email_verified_at, stable_user_id, plan,
			stripe_customer_id, stripe_plan, stripe_credits_eligible
		) VALUES (?, ?, ?, ?, ?, 'free', ?, 'pro', 1)`,
	)
		.bind(
			`${label}-${crypto.randomUUID().slice(0, 8)}`,
			email,
			'test-password-hash',
			now.toISOString(),
			stableUserId,
			stripeCustomerId,
		)
		.run()
	return { email, stableUserId, stripeCustomerId }
}

async function insertPurchasableProOrg(input: {
	id: string
	slug: string
	stripeCustomerId: string
	deletedAt?: string | null
}) {
	await ensureSchema()
	await env.APP_DB.prepare(
		`INSERT INTO orgs (
			id, slug, plan, entitlement_ladder, stripe_customer_id, stripe_plan,
			stripe_credits_eligible, deleted_at, created_at, updated_at
		) VALUES (?, ?, 'free', 'public', ?, 'pro', 1, ?, ?, ?)`,
	)
		.bind(
			input.id,
			input.slug,
			input.stripeCustomerId,
			input.deletedAt ?? null,
			now.toISOString(),
			now.toISOString(),
		)
		.run()
}

async function fund(ownerId: string) {
	await applyCreditPayment({
		db: env.APP_DB,
		userId: ownerId,
		kind: 'top_up',
		amountCents: 1_000,
		stripeReference: `cs_${crypto.randomUUID()}`,
		now,
	})
	return (await readCreditWallet(env.APP_DB, ownerId)).balanceMicroUsd
}

async function setRollup(ownerId: string, uniqueWorkerDays: number) {
	await env.APP_DB.prepare(
		`INSERT INTO usage_rollups (user_id, metric, month, event_count)
		 VALUES (?, 'dynamic_worker_day', ?, ?)
		 ON CONFLICT (user_id, metric, month) DO UPDATE SET event_count = excluded.event_count`,
	)
		.bind(ownerId, month, uniqueWorkerDays)
		.run()
}

async function candidatesFor(ownerId: string) {
	const matches: Awaited<ReturnType<typeof listCreditDebitCandidates>> = []
	let startAfter = ''
	for (let page = 0; page < creditDebitMaxBatchesPerRun; page += 1) {
		const rows = await listCreditDebitCandidates({
			db: env.APP_DB,
			startAfter,
			now,
		})
		for (const row of rows) {
			if (row.user_id === ownerId) matches.push(row)
		}
		const last = rows.at(-1)
		if (!last || rows.length < creditDebitBatchSize) break
		startAfter = last.user_id
	}
	return matches
}

async function debitCount(ownerId: string) {
	const row = await env.APP_DB.prepare(
		`SELECT COUNT(*) AS n FROM credit_ledger_entries
		 WHERE user_id = ? AND kind = 'debit' AND month = ?`,
	)
		.bind(ownerId, month)
		.first<{ n: number }>()
	return Number(row?.n ?? 0)
}

async function rewindDebitCursor() {
	await env.APP_DB.prepare(
		`UPDATE credit_debit_cursor SET position = '' WHERE singleton = 1`,
	).run()
}

async function balance(ownerId: string) {
	return (await readCreditWallet(env.APP_DB, ownerId)).balanceMicroUsd
}

/** One funded day past the Pro include, then a second run that must not charge again. */
async function expectSettledOnce(ownerId: string, startingBalance: number) {
	await setRollup(ownerId, 351)
	await rewindDebitCursor()
	await runCreditDebits({ env, now })
	const expected = startingBalance - oneBillableDayMicroUsd
	expect(await balance(ownerId)).toBe(expected)
	expect(await debitCount(ownerId)).toBe(1)
	await rewindDebitCursor()
	await runCreditDebits({ env, now })
	expect(await balance(ownerId)).toBe(expected)
	expect(await debitCount(ownerId)).toBe(1)
	return expected
}

test('a team org wallet with no matching user is settled once, including budget MTD', async () => {
	const orgId = testStableUserIdFromEmail(
		`team-wallet-${crypto.randomUUID()}@example.com`,
	)
	const stripeCustomerId = `cus_${crypto.randomUUID().slice(0, 8)}`
	const deletedOrgId = testStableUserIdFromEmail(
		`deleted-team-${crypto.randomUUID()}@example.com`,
	)
	await insertPurchasableProOrg({
		id: orgId,
		slug: `team-${orgId.slice(0, 8)}`,
		stripeCustomerId,
	})
	await insertPurchasableProOrg({
		id: deletedOrgId,
		slug: `gone-${deletedOrgId.slice(0, 8)}`,
		stripeCustomerId: `cus_${crypto.randomUUID().slice(0, 8)}`,
		deletedAt: now.toISOString(),
	})
	expect(
		await env.APP_DB.prepare(
			`SELECT 1 AS present FROM users WHERE stable_user_id = ?`,
		)
			.bind(orgId)
			.first(),
	).toBeNull()

	const starting = await fund(orgId)
	const deletedStarting = await fund(deletedOrgId)
	await setRollup(deletedOrgId, 351)
	const candidates = await candidatesFor(orgId)
	expect(candidates).toHaveLength(1)
	expect(await candidatesFor(deletedOrgId)).toEqual([])
	expect(candidates[0]).toMatchObject({
		user_id: orgId,
		email: '',
		stripe_customer_id: stripeCustomerId,
		stripe_plan: 'pro',
		stripe_credits_eligible: 1,
	})

	await expectSettledOnce(orgId, starting)
	expect(await balance(deletedOrgId)).toBe(deletedStarting)
	expect(await debitCount(deletedOrgId)).toBe(0)

	const spend = await userMeterRpc({ env, userId: orgId }).getBudgetSpend({
		month,
	})
	expect(spend.users[orgId]).toBe(oneBillableDayMicroUsd)
	expect(spend.automationMicroUsd).toBe(0)
	await rewindDebitCursor()
	await runCreditDebits({ env, now })
	const replay = await userMeterRpc({ env, userId: orgId }).getBudgetSpend({
		month,
	})
	expect(replay.users[orgId]).toBe(oneBillableDayMicroUsd)
})

test('a personal wallet with no org row is still settled once', async () => {
	const stripeCustomerId = `cus_${crypto.randomUUID().slice(0, 8)}`
	const user = await seedPersonalPro('personal-wallet', stripeCustomerId)
	expect(
		await env.APP_DB.prepare(`SELECT 1 AS present FROM orgs WHERE id = ?`)
			.bind(user.stableUserId)
			.first(),
	).toBeNull()

	const starting = await fund(user.stableUserId)
	const candidates = await candidatesFor(user.stableUserId)
	expect(candidates).toHaveLength(1)
	expect(candidates[0]).toMatchObject({
		user_id: user.stableUserId,
		email: user.email,
		stripe_customer_id: stripeCustomerId,
		stripe_plan: 'pro',
		stripe_credits_eligible: 1,
	})
	await expectSettledOnce(user.stableUserId, starting)
})

test('a personal org that shares stable_user_id is settled once', async () => {
	const stripeCustomerId = `cus_${crypto.randomUUID().slice(0, 8)}`
	const user = await seedPersonalPro('overlap-wallet', stripeCustomerId)
	await insertPurchasableProOrg({
		id: user.stableUserId,
		slug: `person-${user.stableUserId.slice(0, 8)}`,
		stripeCustomerId,
	})
	const starting = await fund(user.stableUserId)
	expect(await candidatesFor(user.stableUserId)).toHaveLength(1)
	const settled = await expectSettledOnce(user.stableUserId, starting)
	expect(await balance(user.stableUserId)).toBe(settled)

	const spend = await userMeterRpc({
		env,
		userId: user.stableUserId,
	}).getBudgetSpend({ month })
	expect(spend.users[user.stableUserId]).toBe(oneBillableDayMicroUsd)
})

test('a live org row supplies every billing column, even when the user row disagrees', async () => {
	const user = await seedPersonalPro(
		'org-row-wins',
		`cus_${crypto.randomUUID().slice(0, 8)}`,
	)
	await env.APP_DB.prepare(
		`INSERT INTO orgs (
			id, slug, plan, entitlement_ladder, stripe_customer_id, stripe_plan,
			stripe_credits_eligible, created_at, updated_at
		) VALUES (?, ?, 'free', 'public', NULL, NULL, 0, ?, ?)`,
	)
		.bind(
			user.stableUserId,
			`partial-${user.stableUserId.slice(0, 8)}`,
			now.toISOString(),
			now.toISOString(),
		)
		.run()
	await fund(user.stableUserId)
	const candidates = await candidatesFor(user.stableUserId)
	expect(candidates).toHaveLength(1)
	expect(candidates[0]).toMatchObject({
		user_id: user.stableUserId,
		email: user.email,
		stripe_customer_id: null,
		plan: 'free',
		stripe_plan: null,
		stripe_credits_eligible: 0,
	})
})
