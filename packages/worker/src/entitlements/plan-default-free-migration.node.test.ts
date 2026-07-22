import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

/** Upper bound (exclusive): only migrations before this file are applied as setup. */
const planDefaultFreeMigration = '0083-plan-default-free.sql'

const inboundUserFkTables = [
	'password_resets',
	'email_verifications',
	'pending_email_changes',
	'passkeys',
	'oauth_connections',
	'user_roles',
	'invites',
	'feature_flags',
	'feature_flag_user_overrides',
] as const

type InboundUserFkTable = (typeof inboundUserFkTables)[number]
type ChildRowSnapshot = Record<
	InboundUserFkTable,
	Array<Record<string, unknown>>
>

/** D1 wraps each migration file in a transaction; PRAGMA foreign_keys=OFF is a no-op. */
function applyMigrationLikeD1(db: DatabaseSync, fileName: string) {
	const sql = readFileSync(new URL(fileName, migrationsDirectory), 'utf8')
	db.exec('BEGIN')
	try {
		db.exec(sql)
		db.exec('COMMIT')
	} catch (error) {
		db.exec('ROLLBACK')
		throw error
	}
}

function applyMigrationsBeforePlanDefaultFree(db: DatabaseSync) {
	db.exec('PRAGMA foreign_keys = ON')
	for (const fileName of readdirSync(migrationsDirectory)
		.filter((file) => file.endsWith('.sql') && file < planDefaultFreeMigration)
		.sort()) {
		db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
	}
}

function listLiveTables(db: DatabaseSync) {
	return (
		db
			.prepare(
				`SELECT name FROM sqlite_master
				 WHERE type = 'table'
				   AND name NOT LIKE 'sqlite_%'
				 ORDER BY name`,
			)
			.all() as Array<{ name: string }>
	).map((row) => row.name)
}

function tablesWithForeignKeyToUsers(db: DatabaseSync) {
	const referencingUsers: string[] = []
	for (const tableName of listLiveTables(db)) {
		const foreignKeys = db
			.prepare(`PRAGMA foreign_key_list(${tableName})`)
			.all() as Array<{ table: string }>
		if (foreignKeys.some((foreignKey) => foreignKey.table === 'users')) {
			referencingUsers.push(tableName)
		}
	}
	return referencingUsers.sort()
}

function assertInboundUserFkInventoryMatches(db: DatabaseSync) {
	expect(tablesWithForeignKeyToUsers(db)).toEqual(
		[...inboundUserFkTables].sort(),
	)
}

function selectAllRowsOrdered(db: DatabaseSync, tableName: string) {
	const columns = (
		db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
			name: string
		}>
	).map((column) => column.name)
	const orderBy = columns.join(', ')
	return db
		.prepare(`SELECT * FROM ${tableName} ORDER BY ${orderBy}`)
		.all() as Array<Record<string, unknown>>
}

function snapshotInboundUserFkRows(db: DatabaseSync): ChildRowSnapshot {
	return Object.fromEntries(
		inboundUserFkTables.map((tableName) => [
			tableName,
			selectAllRowsOrdered(db, tableName),
		]),
	) as ChildRowSnapshot
}

function expectInboundUserFkRowsPreserved(
	db: DatabaseSync,
	beforeRows: ChildRowSnapshot,
	options?: { reconcileInvitePlans?: boolean },
) {
	for (const tableName of inboundUserFkTables) {
		if (tableName === 'invites' && options?.reconcileInvitePlans) {
			const expected = beforeRows.invites.map((row) => ({
				...row,
				plan: row.plan === 'unlimited' ? 'max' : row.plan,
			}))
			expect(selectAllRowsOrdered(db, tableName)).toEqual(expected)
			continue
		}
		expect(selectAllRowsOrdered(db, tableName)).toEqual(beforeRows[tableName])
	}
}

function usersTableSql(db: DatabaseSync) {
	const row = db
		.prepare(
			`SELECT sql FROM sqlite_master
			 WHERE type = 'table' AND name = 'users'`,
		)
		.get() as { sql: string } | undefined
	return row?.sql ?? ''
}

function invitesTableSql(db: DatabaseSync) {
	const row = db
		.prepare(
			`SELECT sql FROM sqlite_master
			 WHERE type = 'table' AND name = 'invites'`,
		)
		.get() as { sql: string } | undefined
	return row?.sql ?? ''
}

function planColumnInfo(db: DatabaseSync, tableName: 'users' | 'invites') {
	return (
		db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
			name: string
			notnull: number
			type: string
			dflt_value: string | null
		}>
	).find((column) => column.name === 'plan')
}

function stripePlanColumnInfo(db: DatabaseSync) {
	return (
		db.prepare(`PRAGMA table_info(users)`).all() as Array<{
			name: string
			notnull: number
			type: string
			dflt_value: string | null
		}>
	).find((column) => column.name === 'stripe_plan')
}

/**
 * Seed after migrations through 0082: plan is NOT NULL DEFAULT 'unlimited',
 * data rename already applied. Residual stored 'unlimited' (reintroduced after
 * 0082) exercises 0083 reconciliation before the DEFAULT 'free' rebuild.
 */
function seedInboundFkRows(db: DatabaseSync) {
	db.exec(`
		INSERT INTO users (
			id, username, email, password_hash, email_verified_at, stable_user_id,
			plan, stripe_customer_id, stripe_plan, display_name, bio,
			profile_visibility, avatar_key, account_type
		) VALUES (
			1, 'alice', 'alice@example.com', 'hash-a', '2026-07-01',
			'custom-preserved-stable-id', 'pro', 'cus_alice', 'free', 'Alice',
			'Builder', 'public', 'user-avatars/alice/a.png', 'person'
		);
		INSERT INTO users (
			id, username, email, password_hash, stable_user_id, plan, stripe_plan,
			account_type
		) VALUES (
			2, 'platform', 'platform@example.com', 'hash-p', 'stable-platform',
			'unlimited', NULL, 'platform'
		);
		INSERT INTO users (
			id, username, email, password_hash, stable_user_id, plan, stripe_plan
		) VALUES (
			3, 'unknown-plan', 'unknown-plan@example.com', 'hash-u', 'stable-unknown-plan',
			'unknown-stored-plan', 'unlimited'
		);
		INSERT INTO users (
			id, username, email, password_hash, stable_user_id, plan, stripe_plan
		) VALUES (
			4, 'max-user', 'max@example.com', 'hash-m', 'stable-max',
			'max', 'pro'
		);

		INSERT INTO password_resets (id, user_id, token_hash, expires_at)
		VALUES (11, 1, 'reset-hash', 999999);
		INSERT INTO email_verifications (id, user_id, token_hash, expires_at)
		VALUES (21, 1, 'verify-hash', 999999);
		INSERT INTO pending_email_changes (
			id, user_id, new_email, token_hash, expires_at
		) VALUES (31, 1, 'alice-new@example.com', 'email-change-hash', 999999);
		INSERT INTO passkeys (
			id, aaguid, public_key, user_id, webauthn_user_handle, counter,
			device_type, backed_up, transports, name, last_used_at
		) VALUES (
			'passkey-1', 'aaguid', 'public-key', 1, 'handle-1', 3, 'platform', 1,
			'internal', 'Laptop', '2026-07-02'
		);
		INSERT INTO oauth_connections (
			id, user_id, provider_name, provider_id, provider_display_name,
			created_at, updated_at
		) VALUES (
			41, 1, 'github', 'gh-1', 'alice-gh', '2026-07-01', '2026-07-01'
		);
		INSERT INTO user_roles (user_id, role_id, created_at)
		SELECT 1, id, '2026-07-01' FROM roles WHERE name = 'user';
		INSERT INTO invites (
			code, created_by, note, max_uses, use_count, expires_at, plan
		) VALUES
			('invite-alice', 1, 'friend', 2, 1, '2026-08-01', 'pro'),
			('invite-unlimited', 2, 'residual unlimited before 0083', 1, 0, NULL, 'unlimited'),
			('invite-unknown-plan', 3, 'unknown stored plan', 4, 2, NULL, 'unknown-stored-plan'),
			('invite-max', 4, 'already max', 1, 0, NULL, 'max');
		INSERT INTO feature_flags (key, enabled, rollout_percent, note, updated_by)
		VALUES ('beta', 1, 25, 'rollout', 1);
		INSERT INTO feature_flag_user_overrides (
			flag_key, user_id, enabled, updated_by, updated_at
		) VALUES ('beta', 1, 0, 2, '2026-07-03');
	`)
}

const allocatedThenDeletedUserId = 1000

test('plan default-free migration reconciles residual unlimited, rebuilds users/invites, and preserves inbound fks under a D1 transaction', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBeforePlanDefaultFree(db)
	seedInboundFkRows(db)
	// Allocate a high user id then delete it so sqlite_sequence sits above live
	// max(id). FK inventory/snapshots stay based on remaining users only.
	db.prepare(
		`INSERT INTO users (
			id, username, email, password_hash, stable_user_id, plan
		) VALUES (?, 'high-water', 'high-water@example.com', 'hash-h',
			'stable-high-water', 'free')`,
	).run(allocatedThenDeletedUserId)
	db.prepare(`DELETE FROM users WHERE id = ?`).run(allocatedThenDeletedUserId)
	expect(
		db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'users'`).get(),
	).toEqual({ seq: allocatedThenDeletedUserId })

	assertInboundUserFkInventoryMatches(db)

	const beforeChildRows = snapshotInboundUserFkRows(db)

	expect(usersTableSql(db)).toContain(`plan TEXT NOT NULL DEFAULT 'unlimited'`)
	expect(invitesTableSql(db)).toContain(
		`plan TEXT NOT NULL DEFAULT 'unlimited'`,
	)
	expect(planColumnInfo(db, 'users')).toMatchObject({
		type: 'TEXT',
		notnull: 1,
		dflt_value: "'unlimited'",
	})
	expect(planColumnInfo(db, 'invites')).toMatchObject({
		type: 'TEXT',
		notnull: 1,
		dflt_value: "'unlimited'",
	})
	expect(stripePlanColumnInfo(db)).toMatchObject({
		type: 'TEXT',
		notnull: 0,
		dflt_value: null,
	})
	expect(
		db
			.prepare(
				`SELECT sql FROM sqlite_master
				 WHERE name LIKE '_mig0083_%'
				    OR name = '__migration_assertions'`,
			)
			.all(),
	).toEqual([])

	applyMigrationLikeD1(db, planDefaultFreeMigration)

	expect(planColumnInfo(db, 'users')).toMatchObject({
		name: 'plan',
		type: 'TEXT',
		notnull: 1,
		dflt_value: "'free'",
	})
	expect(planColumnInfo(db, 'invites')).toMatchObject({
		name: 'plan',
		type: 'TEXT',
		notnull: 1,
		dflt_value: "'free'",
	})
	expect(usersTableSql(db)).toContain(`plan TEXT NOT NULL DEFAULT 'free'`)
	expect(invitesTableSql(db)).toContain(`plan TEXT NOT NULL DEFAULT 'free'`)
	expect(usersTableSql(db)).not.toMatch(/plan TEXT[^,\n]*CHECK/)
	expect(invitesTableSql(db)).not.toMatch(/plan TEXT[^,\n]*CHECK/)
	expect(usersTableSql(db)).not.toContain(`DEFAULT 'unlimited'`)
	expect(invitesTableSql(db)).not.toContain(`DEFAULT 'unlimited'`)
	expect(stripePlanColumnInfo(db)).toMatchObject({
		type: 'TEXT',
		notnull: 0,
		dflt_value: null,
	})
	expect(
		db
			.prepare(
				`SELECT name, sql FROM sqlite_master
				 WHERE type = 'index' AND tbl_name = 'users' AND sql IS NOT NULL
				 ORDER BY name`,
			)
			.all(),
	).toEqual([
		{
			name: 'idx_users_email',
			sql: 'CREATE INDEX idx_users_email ON users(email)',
		},
		{
			name: 'idx_users_stable_user_id',
			sql: 'CREATE UNIQUE INDEX idx_users_stable_user_id\n\tON users(stable_user_id)',
		},
		{
			name: 'idx_users_stripe_customer_id',
			sql: 'CREATE UNIQUE INDEX idx_users_stripe_customer_id\n\tON users(stripe_customer_id)\n\tWHERE stripe_customer_id IS NOT NULL',
		},
		{
			name: 'idx_users_username',
			sql: 'CREATE INDEX idx_users_username ON users(username)',
		},
	])
	expect(
		db
			.prepare(
				`SELECT name, sql FROM sqlite_master
				 WHERE type = 'index' AND tbl_name = 'invites' AND sql IS NOT NULL
				 ORDER BY name`,
			)
			.all(),
	).toEqual([
		{
			name: 'idx_invites_created_at',
			sql: 'CREATE INDEX idx_invites_created_at ON invites(created_at)',
		},
		{
			name: 'idx_invites_created_by',
			sql: 'CREATE INDEX idx_invites_created_by ON invites(created_by)',
		},
		{
			name: 'idx_invites_expires_at',
			sql: 'CREATE INDEX idx_invites_expires_at ON invites(expires_at)',
		},
	])
	expect(
		db
			.prepare(
				`SELECT sql FROM sqlite_master
				 WHERE name LIKE '_mig0083_%'
				    OR name = '__migration_assertions'
				    OR name LIKE '%_next'`,
			)
			.all(),
	).toEqual([])

	expect(
		db
			.prepare(
				`SELECT id, email, stable_user_id, plan, stripe_customer_id,
					stripe_plan, display_name, bio, profile_visibility, avatar_key,
					account_type
				 FROM users
				 ORDER BY id`,
			)
			.all(),
	).toEqual([
		{
			id: 1,
			email: 'alice@example.com',
			stable_user_id: 'custom-preserved-stable-id',
			plan: 'pro',
			stripe_customer_id: 'cus_alice',
			stripe_plan: 'free',
			display_name: 'Alice',
			bio: 'Builder',
			profile_visibility: 'public',
			avatar_key: 'user-avatars/alice/a.png',
			account_type: 'person',
		},
		{
			id: 2,
			email: 'platform@example.com',
			stable_user_id: 'stable-platform',
			plan: 'max',
			stripe_customer_id: null,
			stripe_plan: null,
			display_name: null,
			bio: null,
			profile_visibility: 'public',
			avatar_key: null,
			account_type: 'platform',
		},
		{
			id: 3,
			email: 'unknown-plan@example.com',
			stable_user_id: 'stable-unknown-plan',
			plan: 'unknown-stored-plan',
			stripe_customer_id: null,
			stripe_plan: 'unlimited',
			display_name: null,
			bio: null,
			profile_visibility: 'public',
			avatar_key: null,
			account_type: 'person',
		},
		{
			id: 4,
			email: 'max@example.com',
			stable_user_id: 'stable-max',
			plan: 'max',
			stripe_customer_id: null,
			stripe_plan: 'pro',
			display_name: null,
			bio: null,
			profile_visibility: 'public',
			avatar_key: null,
			account_type: 'person',
		},
	])
	expect(
		db
			.prepare(
				`SELECT code, created_by, note, max_uses, use_count, expires_at, plan
				 FROM invites
				 ORDER BY code`,
			)
			.all(),
	).toEqual([
		{
			code: 'invite-alice',
			created_by: 1,
			note: 'friend',
			max_uses: 2,
			use_count: 1,
			expires_at: '2026-08-01',
			plan: 'pro',
		},
		{
			code: 'invite-max',
			created_by: 4,
			note: 'already max',
			max_uses: 1,
			use_count: 0,
			expires_at: null,
			plan: 'max',
		},
		{
			code: 'invite-unknown-plan',
			created_by: 3,
			note: 'unknown stored plan',
			max_uses: 4,
			use_count: 2,
			expires_at: null,
			plan: 'unknown-stored-plan',
		},
		{
			code: 'invite-unlimited',
			created_by: 2,
			note: 'residual unlimited before 0083',
			max_uses: 1,
			use_count: 0,
			expires_at: null,
			plan: 'max',
		},
	])
	expect(
		db
			.prepare(`SELECT COUNT(*) AS count FROM users WHERE plan = 'unlimited'`)
			.get(),
	).toEqual({ count: 0 })
	expect(
		db
			.prepare(`SELECT COUNT(*) AS count FROM invites WHERE plan = 'unlimited'`)
			.get(),
	).toEqual({ count: 0 })

	expectInboundUserFkRowsPreserved(db, beforeChildRows, {
		reconcileInvitePlans: true,
	})
	expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([])
	assertInboundUserFkInventoryMatches(db)

	expect(
		db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'users'`).get(),
	).toEqual({ seq: allocatedThenDeletedUserId })

	db.prepare(
		`INSERT INTO users (username, email, password_hash, stable_user_id)
		 VALUES ('carol', 'carol@example.com', 'hash-c', 'stable-carol')`,
	).run()
	expect(
		db.prepare(`SELECT id, plan FROM users WHERE username = 'carol'`).get(),
	).toEqual({ id: allocatedThenDeletedUserId + 1, plan: 'free' })

	db.prepare(
		`INSERT INTO invites (code, created_by, note)
		 VALUES ('invite-default', ?, 'default plan')`,
	).run(allocatedThenDeletedUserId + 1)
	expect(
		db.prepare(`SELECT plan FROM invites WHERE code = 'invite-default'`).get(),
	).toEqual({ plan: 'free' })

	expect(() => {
		db.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id, plan)
			 VALUES ('nope', 'nope@example.com', 'hash', 'stable-nope', NULL)`,
		).run()
	}).toThrow(/NOT NULL constraint failed: users\.plan/)

	expect(() => {
		db.prepare(
			`INSERT INTO invites (code, created_by, note, plan)
			 VALUES ('invite-nope', ?, 'nope', NULL)`,
		).run(allocatedThenDeletedUserId + 1)
	}).toThrow(/NOT NULL constraint failed: invites\.plan/)

	db.prepare(
		`INSERT INTO users (
			username, email, password_hash, stable_user_id, plan, stripe_plan
		) VALUES (
			'still-null-stripe', 'stripe-null@example.com', 'hash-s',
			'stable-stripe-null', 'pro', NULL
		)`,
	).run()
	expect(
		db
			.prepare(
				`SELECT plan, stripe_plan FROM users
				 WHERE username = 'still-null-stripe'`,
			)
			.get(),
	).toEqual({ plan: 'pro', stripe_plan: null })

	db.exec('PRAGMA foreign_keys = ON')
	db.prepare(`DELETE FROM users WHERE id = 1`).run()
	expect(
		db.prepare(`SELECT COUNT(*) AS count FROM pending_email_changes`).get(),
	).toEqual({ count: 0 })
	expect(
		db.prepare(`SELECT COUNT(*) AS count FROM password_resets`).get(),
	).toEqual({ count: 0 })
	expect(
		db.prepare(`SELECT COUNT(*) AS count FROM oauth_connections`).get(),
	).toEqual({ count: 0 })
	expect(
		db
			.prepare(`SELECT created_by FROM invites WHERE code = 'invite-alice'`)
			.get(),
	).toEqual({ created_by: null })
})

test('plan default-free migration fails closed and rolls back when reconciliation cannot clear unlimited plans', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBeforePlanDefaultFree(db)
	seedInboundFkRows(db)
	db.prepare(
		`INSERT INTO users (
			id, username, email, password_hash, stable_user_id, plan
		) VALUES (?, 'high-water', 'high-water@example.com', 'hash-h',
			'stable-high-water', 'free')`,
	).run(allocatedThenDeletedUserId)
	db.prepare(`DELETE FROM users WHERE id = ?`).run(allocatedThenDeletedUserId)
	assertInboundUserFkInventoryMatches(db)

	const beforeChildRows = snapshotInboundUserFkRows(db)
	const beforeUsers = db
		.prepare(`SELECT username, plan, stripe_plan FROM users ORDER BY id`)
		.all()
	const beforeInvites = db
		.prepare(`SELECT code, plan FROM invites ORDER BY code`)
		.all()
	const beforeUsersSql = usersTableSql(db)
	const beforeInvitesSql = invitesTableSql(db)
	const beforeUsersSeq = db
		.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'users'`)
		.get()

	// Force one eligible users.plan 'unlimited' to survive the real UPDATE so
	// the migration's residual-unlimited assertion aborts. Created outside the
	// D1-style migration transaction so the ignore behavior persists through
	// rollback.
	db.exec(`
		CREATE TRIGGER test_keep_unlimited_plan_user
		BEFORE UPDATE OF plan ON users
		WHEN OLD.id = 2 AND OLD.plan = 'unlimited'
		BEGIN
			SELECT RAISE(IGNORE);
		END;
	`)

	expect(() => applyMigrationLikeD1(db, planDefaultFreeMigration)).toThrow(
		/CHECK constraint failed: 0/,
	)

	expect(usersTableSql(db)).toBe(beforeUsersSql)
	expect(invitesTableSql(db)).toBe(beforeInvitesSql)
	expect(usersTableSql(db)).toContain(`plan TEXT NOT NULL DEFAULT 'unlimited'`)
	expect(invitesTableSql(db)).toContain(
		`plan TEXT NOT NULL DEFAULT 'unlimited'`,
	)
	expect(usersTableSql(db)).not.toContain(`DEFAULT 'free'`)
	expect(invitesTableSql(db)).not.toContain(`DEFAULT 'free'`)
	expect(
		db
			.prepare(`SELECT username, plan, stripe_plan FROM users ORDER BY id`)
			.all(),
	).toEqual(beforeUsers)
	expect(
		db.prepare(`SELECT code, plan FROM invites ORDER BY code`).all(),
	).toEqual(beforeInvites)
	expect(
		db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'users'`).get(),
	).toEqual(beforeUsersSeq)
	expect(beforeUsersSeq).toEqual({ seq: allocatedThenDeletedUserId })
	expectInboundUserFkRowsPreserved(db, beforeChildRows)
	expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([])
	expect(
		db
			.prepare(
				`SELECT sql FROM sqlite_master
				 WHERE name LIKE '_mig0083_%'
				    OR name = '__migration_assertions'
				    OR name LIKE '%_next'`,
			)
			.all(),
	).toEqual([])
})
