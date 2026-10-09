import { env } from 'cloudflare:workers'
import { utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import { expect, test } from 'vitest'
import { seedAccount } from '#worker/test-support/workers-seed.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { ensureEntitlementTestSchema } from './test-schema.ts'
import { consumeDailyEntitlement } from './service.ts'
import { isBudgetLimitError } from './errors.ts'
import { userMeterRpc } from './user-meter-client.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'

const now = new Date('2026-03-15T12:00:00.000Z')
const month = utcMonthKey(now)

async function ensureBudgetSchema(db: D1Database) {
	await ensureOrgsTestSchema(db)
	await db
		.prepare(
			`ALTER TABLE orgs ADD COLUMN default_user_budget_micro_usd INTEGER`,
		)
		.run()
	await db
		.prepare(`ALTER TABLE orgs ADD COLUMN automation_budget_micro_usd INTEGER`)
		.run()
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
