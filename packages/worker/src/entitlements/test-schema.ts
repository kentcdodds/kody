import { ensureUserStorageBucketsTestSchema } from '#worker/storage-buckets/test-schema.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'

/**
 * Non-destructive schema for entitlement primitives in workers-unit tests,
 * where the D1 database starts empty and each suite provisions the tables it
 * needs. Mirrors Stripe billing columns (0066) and package-service state on
 * top of the shared `users` schema. Code no longer reads or writes the D1
 * `entitlement_daily_counters` mirror; daily counters live only in UserMeter.
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
			`CREATE TABLE IF NOT EXISTS package_service_states (
	user_id TEXT NOT NULL,
	package_id TEXT NOT NULL,
	service_name TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('running', 'idle', 'stopped', 'error')),
	started_at TEXT,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (user_id, package_id, service_name)
)`,
		)
		.run()
	await db
		.prepare(
			`CREATE INDEX IF NOT EXISTS idx_package_service_states_user_status
			 ON package_service_states(user_id, status)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS stripe_webhook_events (
	event_id TEXT PRIMARY KEY NOT NULL,
	event_type TEXT NOT NULL,
	processed_at TEXT NOT NULL
)`,
		)
		.run()
	await ensureUserStorageBucketsTestSchema(db)
}
