import { ensureEntitlementTestSchema } from '#worker/entitlements/test-schema.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'

/**
 * Mirrors `0069-prepaid-credits.sql` (wallets, ledger, debit progress) on
 * top of the entitlement `users` schema and `usage_rollups` for
 * `*.workers.test.ts` suites, which run against an empty local D1.
 */
export async function ensureCreditWalletTestSchema(db: D1Database) {
	await ensureEntitlementTestSchema(db)
	await ensureUsageRollupsTestSchema(db)
	const statements = [
		`CREATE TABLE IF NOT EXISTS credit_wallets (
	user_id TEXT PRIMARY KEY NOT NULL,
	balance_micro_usd INTEGER NOT NULL DEFAULT 0,
	auto_refill_enabled INTEGER NOT NULL DEFAULT 0,
	auto_refill_threshold_cents INTEGER,
	auto_refill_amount_cents INTEGER,
	auto_refill_monthly_cap_cents INTEGER,
	auto_refill_payment_method_id TEXT,
	auto_refill_failed_at TEXT,
	notify_auto_refilled INTEGER NOT NULL DEFAULT 1,
	notify_monthly_cap INTEGER NOT NULL DEFAULT 1,
	notify_low_balance INTEGER NOT NULL DEFAULT 1,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
)`,
		`CREATE TABLE IF NOT EXISTS credit_ledger_entries (
	id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('top_up', 'auto_refill', 'admin_grant', 'debit')),
	amount_micro_usd INTEGER NOT NULL,
	meter TEXT,
	month TEXT,
	units INTEGER,
	stripe_reference TEXT,
	granted_by_user_id TEXT,
	note TEXT,
	created_at TEXT NOT NULL
)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_entries_stripe_reference
	ON credit_ledger_entries (stripe_reference)
	WHERE stripe_reference IS NOT NULL`,
		`CREATE TABLE IF NOT EXISTS credit_debit_progress (
	user_id TEXT NOT NULL,
	month TEXT NOT NULL,
	meter TEXT NOT NULL,
	accounted_units INTEGER NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (user_id, month, meter)
)`,
	]
	for (const statement of statements) {
		await db.prepare(statement).run()
	}
}
