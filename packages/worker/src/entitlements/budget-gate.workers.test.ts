import { env } from 'cloudflare:workers'
import { utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import { expect, test } from 'vitest'
import { seedAccount } from '#worker/test-support/workers-seed.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { ensureEntitlementTestSchema } from './test-schema.ts'
import { consumeDailyEntitlement } from './service.ts'
import { isBudgetLimitError } from './errors.ts'
import {
	recordOrgBudgetSpend,
	syncOrgBudgetSpendFromCreditLedger,
} from './budget-gate.ts'
import { userMeterRpc } from './user-meter-client.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { ensureCreditWalletTestSchema } from '#worker/billing/test-schema.ts'

const now = new Date('2026-03-15T12:00:00.000Z')
const month = utcMonthKey(now)

async function ensureBudgetSchema(db: D1Database) {
	await ensureOrgsTestSchema(db)
	for (const sql of [
		`ALTER TABLE orgs ADD COLUMN default_user_budget_micro_usd INTEGER`,
		`ALTER TABLE orgs ADD COLUMN automation_budget_micro_usd INTEGER`,
	]) {
		try {
			await db.prepare(sql).run()
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			if (!/duplicate column name/i.test(message)) throw error
		}
	}
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS org_user_budgets (
				org_id TEXT NOT NULL,
				user_id TEXT NOT NULL,
				monthly_budget_micro_usd INTEGER NOT NULL,
				set_by_user_id TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				deleted_at TEXT,
				PRIMARY KEY (org_id, user_id)
			)`,
		)
		.run()
}

test('over user budget denies new execute via consumeDailyEntitlement', async () => {
	await ensureEntitlementTestSchema(env.APP_DB)
	await ensureBudgetSchema(env.APP_DB)
	const email = `budget-gate-${crypto.randomUUID()}@example.com`
	const userId = testStableUserIdFromEmail(email)
	const orgId = userId
	await seedAccount({
		db: env.APP_DB,
		email,
		username: 'sam',
		plan: 'free',
		stableUserId: userId,
	})
	await env.APP_DB.prepare(
		`INSERT INTO orgs (
				id, slug, plan, created_at, updated_at,
				default_user_budget_micro_usd, automation_budget_micro_usd
			) VALUES (?, ?, 'free', ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
				slug = excluded.slug,
				default_user_budget_micro_usd = excluded.default_user_budget_micro_usd,
				automation_budget_micro_usd = excluded.automation_budget_micro_usd`,
	)
		.bind(orgId, 'acme', now.toISOString(), now.toISOString(), 50_000_000, null)
		.run()
	const meter = userMeterRpc({ env, userId: orgId })
	await meter.assertWithinBudgetAndRecord({
		month,
		actorUserId: userId,
		automationSource: null,
		deltaMicroUsd: 50_000_000,
		userBudgetMicroUsd: 50_000_000,
		automationBudgetMicroUsd: null,
		actorUsername: 'sam',
		orgSlug: 'acme',
	})

	const error = await consumeDailyEntitlement({
		db: env.APP_DB,
		env,
		userId,
		email,
		resource: 'execute_calls_per_day',
		now,
		orgBudget: {
			orgId,
			orgSlug: 'acme',
			actorUserId: userId,
			actorUsername: 'sam',
		},
	}).then(
		() => null,
		(caught: unknown) => caught,
	)
	expect(isBudgetLimitError(error)).toBe(true)
	if (!isBudgetLimitError(error)) return
	expect(error.message).toContain('@sam')
	expect(error.message).toContain('@acme')
})

test('recordOrgBudgetSpend skips past-month debits without resetting live MTD', async () => {
	await ensureEntitlementTestSchema(env.APP_DB)
	await ensureBudgetSchema(env.APP_DB)
	const email = `past-month-${crypto.randomUUID()}@example.com`
	const userId = testStableUserIdFromEmail(email)
	const orgId = userId
	const april = new Date('2026-04-10T12:00:00.000Z')
	const march = '2026-03'
	await seedAccount({
		db: env.APP_DB,
		email,
		username: 'april-user',
		plan: 'free',
		stableUserId: userId,
	})
	await env.APP_DB.prepare(
		`INSERT INTO orgs (
				id, slug, plan, created_at, updated_at,
				default_user_budget_micro_usd, automation_budget_micro_usd
			) VALUES (?, ?, 'free', ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET slug = excluded.slug`,
	)
		.bind(
			orgId,
			'april-org',
			april.toISOString(),
			april.toISOString(),
			null,
			null,
		)
		.run()
	const meter = userMeterRpc({ env, userId: orgId })
	await meter.assertWithinBudgetAndRecord({
		month: utcMonthKey(april),
		actorUserId: userId,
		automationSource: null,
		deltaMicroUsd: 10_000_000,
		userBudgetMicroUsd: 50_000_000,
		automationBudgetMicroUsd: null,
		actorUsername: 'april-user',
		orgSlug: 'april-org',
	})
	await recordOrgBudgetSpend({
		db: env.APP_DB,
		env,
		orgId,
		actorUserId: userId,
		automationSource: null,
		deltaMicroUsd: 5_000_000,
		now: april,
		month: march,
	})
	const state = await meter.getBudgetSpend({ month: utcMonthKey(april) })
	expect(state.users[userId]).toBe(10_000_000)
})

test('syncOrgBudgetSpendFromCreditLedger recovers MTD from ledger and weights overage only', async () => {
	await ensureEntitlementTestSchema(env.APP_DB)
	await ensureBudgetSchema(env.APP_DB)
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
	const email = `sync-budget-${crypto.randomUUID()}@example.com`
	const orgId = testStableUserIdFromEmail(email)
	const memberA = testStableUserIdFromEmail(`a-${email}`)
	const memberB = testStableUserIdFromEmail(`b-${email}`)
	await seedAccount({
		db: env.APP_DB,
		email,
		username: 'sync-owner',
		plan: 'pro',
		stableUserId: orgId,
	})
	await env.APP_DB.prepare(
		`INSERT INTO orgs (
				id, slug, plan, created_at, updated_at,
				default_user_budget_micro_usd, automation_budget_micro_usd
			) VALUES (?, ?, 'pro', ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET slug = excluded.slug`,
	)
		.bind(orgId, 'sync-org', now.toISOString(), now.toISOString(), null, null)
		.run()
	await env.APP_DB.prepare(
		`INSERT INTO usage_attribution_daily
			(user_id, day, package_id, meter, units, actor_user_id, automation_source)
		 VALUES
			(?, '2026-03-01', 'pkg', 'unique_worker_days', 10, ?, NULL),
			(?, '2026-03-02', 'pkg', 'unique_worker_days', 5, ?, NULL)`,
	)
		.bind(orgId, memberA, orgId, memberB)
		.run()
	await env.APP_DB.prepare(
		`INSERT INTO credit_ledger_entries
			(id, user_id, kind, amount_micro_usd, meter, month, units, created_at)
		 VALUES (?, ?, 'debit', ?, 'unique_worker_days', ?, ?, ?)`,
	)
		.bind(
			`debit:${orgId}:${month}:unique_worker_days:0`,
			orgId,
			-20_000,
			month,
			5,
			now.toISOString(),
		)
		.run()

	await syncOrgBudgetSpendFromCreditLedger({
		db: env.APP_DB,
		env,
		orgId,
		month,
		includes: [
			{ meter: 'unique_worker_days', include: 10 },
			{ meter: 'durable_object_rows_read', include: 0 },
		],
		now,
	})
	const meter = userMeterRpc({ env, userId: orgId })
	const first = await meter.getBudgetSpend({ month })
	expect(first.users[memberA] ?? 0).toBe(0)
	expect(first.users[memberB]).toBe(20_000)

	// Idempotent replay must not double-count.
	await syncOrgBudgetSpendFromCreditLedger({
		db: env.APP_DB,
		env,
		orgId,
		month,
		includes: [
			{ meter: 'unique_worker_days', include: 10 },
			{ meter: 'durable_object_rows_read', include: 0 },
		],
		now,
	})
	const second = await meter.getBudgetSpend({ month })
	expect(second.users[memberB]).toBe(20_000)
})
