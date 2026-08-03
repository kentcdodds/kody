/**
 * Shared `users` provisioning for `*.workers.test.ts` suites. Local D1 starts
 * empty and never applies migrations, so each suite creates the tables it
 * needs — and several suites share one database, so the same `users` table can
 * already exist with fewer columns than the current suite wants.
 *
 * Every column therefore has a fresh `CREATE TABLE` form and (where SQLite
 * allows it) an additive `ALTER TABLE ... ADD COLUMN` form. Feature-specific
 * tables stay in the feature's own `test-schema.ts`; only `users` and the
 * account write leases that gate every user-scoped write live here.
 */

/**
 * Columns beyond the always-present core that a suite can opt into. Suites
 * request only what they assert on so the helper keeps documenting which
 * migrations each suite depends on.
 */
export type UsersTestSchemaColumn =
	| 'email_verified_at'
	| 'account_type'
	| 'stripe_customer_id'
	| 'stripe_plan'
	| 'stripe_plan_refreshed_at'
	| 'display_name'
	| 'bio'
	| 'avatar_key'
	| 'profile_visibility'

type UsersColumnDefinition = {
	/** Definition used by the fresh `CREATE TABLE users`. */
	create: string
	/**
	 * Definition used by `ALTER TABLE users ADD COLUMN` when a preexisting
	 * shared table needs the column. SQLite cannot add `NOT NULL` without a
	 * constant default, so some alter forms are weaker than the create form.
	 * Omit to reuse `create`.
	 */
	alter?: string
}

/**
 * Present in every suite. `id`, `username`, `email`, `password_hash`,
 * `created_at`, and `updated_at` cannot be added by `ALTER TABLE` (identity,
 * `UNIQUE`, `NOT NULL` without a default, non-constant defaults), so they only
 * ever come from the fresh `CREATE TABLE`.
 */
const nonAdditiveCoreColumns = [
	'id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL',
	'username TEXT NOT NULL UNIQUE',
	'email TEXT NOT NULL UNIQUE',
	'password_hash TEXT NOT NULL',
] as const

const timestampColumns = [
	'created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)',
	'updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)',
] as const

/**
 * Mirrors migrations 0052 + 0075 (`stable_user_id` NOT NULL + unique index),
 * 0081 + 0083 (`plan` NOT NULL DEFAULT `'free'`), account deletion/suspension
 * state, and the account write lease counters. Non-historical seeds may set
 * `'max'` or `'free'` explicitly when plan matters.
 */
const alwaysAdditiveColumns: Record<string, UsersColumnDefinition> = {
	// Preexisting shared tables: ALTER ADD COLUMN cannot express NOT NULL
	// without a default; nullable TEXT matches migration 0052's add step.
	stable_user_id: { create: 'TEXT NOT NULL', alter: 'TEXT' },
	plan: { create: `TEXT NOT NULL DEFAULT 'free'` },
	deleting_at: { create: 'TEXT' },
	suspended_at: { create: 'TEXT' },
	email_outbound_paused_at: { create: 'TEXT' },
	active_write_count: { create: 'INTEGER NOT NULL DEFAULT 0' },
	active_write_expires_at: { create: 'TEXT' },
	d1_storage_bytes: { create: 'INTEGER NOT NULL DEFAULT 0' },
	d1_storage_bytes_updated_at: { create: 'TEXT' },
}

/**
 * Opt-in columns. `account_type` mirrors migration 0072, the Stripe columns
 * mirror 0066, `email_verified_at` mirrors 0046, and the profile columns mirror
 * the community social migration. `CHECK` constraints are dropped from the
 * alter forms to match what the migrations do for preexisting tables.
 */
const optionalColumns: Record<UsersTestSchemaColumn, UsersColumnDefinition> = {
	email_verified_at: { create: 'TEXT' },
	account_type: {
		create: `TEXT NOT NULL DEFAULT 'person' CHECK (account_type IN ('person', 'platform'))`,
		alter: `TEXT NOT NULL DEFAULT 'person'`,
	},
	stripe_customer_id: { create: 'TEXT' },
	stripe_plan: { create: 'TEXT' },
	stripe_plan_refreshed_at: { create: 'TEXT' },
	display_name: { create: 'TEXT' },
	bio: { create: 'TEXT' },
	avatar_key: { create: 'TEXT' },
	profile_visibility: {
		create: `TEXT NOT NULL DEFAULT 'public' CHECK (profile_visibility IN ('public', 'private'))`,
		alter: `TEXT NOT NULL DEFAULT 'public'`,
	},
}

export async function ensureUsersTestSchema(input: {
	db: D1Database
	columns?: ReadonlyArray<UsersTestSchemaColumn>
}) {
	const additive: Array<readonly [string, UsersColumnDefinition]> = [
		...Object.entries(alwaysAdditiveColumns),
		...(input.columns ?? []).map(
			(column) => [column, optionalColumns[column]] as const,
		),
	]

	const createColumns = [
		...nonAdditiveCoreColumns,
		...additive.map(([name, definition]) => `${name} ${definition.create}`),
		...timestampColumns,
	]
	await input.db
		.prepare(
			`CREATE TABLE IF NOT EXISTS users (\n\t${createColumns.join(',\n\t')}\n)`,
		)
		.run()

	for (const [name, definition] of additive) {
		try {
			await input.db
				.prepare(
					`ALTER TABLE users ADD COLUMN ${name} ${definition.alter ?? definition.create}`,
				)
				.run()
		} catch {
			// The column already exists (fresh CREATE above, or a prior suite).
		}
	}

	try {
		await input.db
			.prepare(
				`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_stable_user_id
				 ON users(stable_user_id)`,
			)
			.run()
	} catch {
		// Index already exists, or a partial legacy index remains from an
		// earlier suite sharing this database.
	}

	await input.db
		.prepare(
			`CREATE TABLE IF NOT EXISTS account_write_leases (
				token TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				holder TEXT NOT NULL,
				acquired_at TEXT NOT NULL,
				released_at TEXT
			)`,
		)
		.run()
}
