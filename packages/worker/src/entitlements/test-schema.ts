import { ensureUserStorageBucketsTestSchema } from '#worker/storage-buckets/test-schema.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'

/**
 * Non-destructive schema for entitlement primitives in workers-unit tests,
 * where the D1 database starts empty and each suite provisions the tables it
 * needs. Mirrors Stripe billing columns (0066) on top of the shared `users`
 * schema. Daily counters live only in UserMeter.
 *
 * Also provisions `user_storage_buckets` because entitlement suites that touch
 * StorageRunner writes register ownership through that table.
 */
export async function ensureEntitlementTestSchema(db: D1Database) {
	await ensureUsersTestSchema({
		db,
		columns: [
			'email_verified_at',
			'stripe_customer_id',
			'stripe_plan',
			'stripe_plan_refreshed_at',
		],
	})
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS stripe_webhook_events (
	event_id TEXT PRIMARY KEY NOT NULL,
	event_type TEXT NOT NULL,
	processed_at TEXT NOT NULL
)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS d1_storage_reconcile_cursor (
	singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
	position TEXT NOT NULL DEFAULT '',
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
)`,
		)
		.run()
	await db
		.prepare(
			`INSERT OR IGNORE INTO d1_storage_reconcile_cursor (singleton, position)
			VALUES (1, '')`,
		)
		.run()
	await ensureUserStorageBucketsTestSchema(db)
}
