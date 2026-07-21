import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../migrations/', import.meta.url)

/** Upper bound (exclusive): only migrations before this file are applied as setup. */
const stableUserIdNotNullMigration = '0075-stable-user-id-not-null.sql'

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

function applyMigrationsBeforeNotNull(db: DatabaseSync) {
	db.exec('PRAGMA foreign_keys = ON')
	for (const fileName of readdirSync(migrationsDirectory)
		.filter(
			(file) => file.endsWith('.sql') && file < stableUserIdNotNullMigration,
		)
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
) {
	for (const tableName of inboundUserFkTables) {
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

function stableUserIdIndexSql(db: DatabaseSync) {
	const row = db
		.prepare(
			`SELECT sql FROM sqlite_master
			 WHERE type = 'index' AND name = 'idx_users_stable_user_id'`,
		)
		.get() as { sql: string | null } | undefined
	return row?.sql ?? ''
}

function seedInboundFkRows(db: DatabaseSync) {
	db.exec(`
		INSERT INTO users (
			id, username, email, password_hash, email_verified_at, stable_user_id,
			plan, stripe_customer_id, display_name, bio, profile_visibility,
			avatar_key, account_type
		) VALUES (
			1, 'alice', 'alice@example.com', 'hash-a', '2026-07-01',
			'custom-preserved-stable-id', 'pro', 'cus_alice', 'Alice', 'Builder',
			'public', 'user-avatars/alice/a.png', 'person'
		);
		INSERT INTO users (
			id, username, email, password_hash, stable_user_id, account_type
		) VALUES (
			2, 'platform', 'platform@example.com', 'hash-p', 'stable-platform',
			'platform'
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
		INSERT INTO invites (code, created_by, note, max_uses, use_count)
		VALUES ('invite-alice', 1, 'friend', 2, 1);
		INSERT INTO feature_flags (key, enabled, rollout_percent, note, updated_by)
		VALUES ('beta', 1, 25, 'rollout', 1);
		INSERT INTO feature_flag_user_overrides (
			flag_key, user_id, enabled, updated_by, updated_at
		) VALUES ('beta', 1, 0, 2, '2026-07-03');
	`)
}

test('stable user id not-null migration rebuilds users and preserves inbound fks under a D1 transaction', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBeforeNotNull(db)
	seedInboundFkRows(db)
	assertInboundUserFkInventoryMatches(db)

	const beforeChildRows = snapshotInboundUserFkRows(db)

	expect(usersTableSql(db)).toContain('stable_user_id TEXT')
	expect(usersTableSql(db)).not.toContain('stable_user_id TEXT NOT NULL')
	expect(stableUserIdIndexSql(db)).toContain('WHERE stable_user_id IS NOT NULL')
	expect(
		db
			.prepare(`SELECT sql FROM sqlite_master WHERE name LIKE '_mig0075_%'`)
			.all(),
	).toEqual([])

	applyMigrationLikeD1(db, stableUserIdNotNullMigration)

	const stableColumn = (
		db.prepare(`PRAGMA table_info(users)`).all() as Array<{
			name: string
			notnull: number
			type: string
			dflt_value: string | null
		}>
	).find((column) => column.name === 'stable_user_id')
	expect(stableColumn).toMatchObject({
		name: 'stable_user_id',
		type: 'TEXT',
		notnull: 1,
		dflt_value: null,
	})
	expect(usersTableSql(db)).toContain('stable_user_id TEXT NOT NULL')
	expect(stableUserIdIndexSql(db)).toBe(
		'CREATE UNIQUE INDEX idx_users_stable_user_id\n\tON users(stable_user_id)',
	)
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
			.prepare(`SELECT sql FROM sqlite_master WHERE name LIKE '_mig0075_%'`)
			.all(),
	).toEqual([])

	expect(
		db
			.prepare(
				`SELECT id, email, stable_user_id, plan, stripe_customer_id,
					display_name, bio, profile_visibility, avatar_key, account_type
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
			plan: null,
			stripe_customer_id: null,
			display_name: null,
			bio: null,
			profile_visibility: 'public',
			avatar_key: null,
			account_type: 'platform',
		},
	])

	expectInboundUserFkRowsPreserved(db, beforeChildRows)

	expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([])

	expect(
		db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'users'`).get(),
	).toEqual({ seq: 2 })

	db.prepare(
		`INSERT INTO users (username, email, password_hash, stable_user_id)
		 VALUES ('carol', 'carol@example.com', 'hash-c', 'stable-carol')`,
	).run()
	expect(
		db.prepare(`SELECT id FROM users WHERE username = 'carol'`).get(),
	).toEqual({ id: 3 })

	expect(() => {
		db.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			 VALUES ('nope', 'nope@example.com', 'hash', NULL)`,
		).run()
	}).toThrow(/NOT NULL constraint failed: users\.stable_user_id/)

	expect(() => {
		db.prepare(
			`INSERT INTO users (username, email, password_hash)
			 VALUES ('nope2', 'nope2@example.com', 'hash')`,
		).run()
	}).toThrow(/NOT NULL constraint failed: users\.stable_user_id/)

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

test('stable user id not-null migration fails closed when any NULL stable id remains', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBeforeNotNull(db)
	seedInboundFkRows(db)
	assertInboundUserFkInventoryMatches(db)
	db.prepare(
		`INSERT INTO users (username, email, password_hash, stable_user_id)
		 VALUES (?, ?, ?, ?)`,
	).run('legacy', 'legacy@example.com', 'hash', null)

	const beforeChildRows = snapshotInboundUserFkRows(db)

	expect(() => applyMigrationLikeD1(db, stableUserIdNotNullMigration)).toThrow(
		/NOT NULL constraint failed: users_next\.stable_user_id/,
	)

	expect(usersTableSql(db)).not.toContain('stable_user_id TEXT NOT NULL')
	expect(stableUserIdIndexSql(db)).toContain('WHERE stable_user_id IS NOT NULL')
	expect(
		db.prepare(`SELECT username, stable_user_id FROM users ORDER BY id`).all(),
	).toEqual([
		{ username: 'alice', stable_user_id: 'custom-preserved-stable-id' },
		{ username: 'platform', stable_user_id: 'stable-platform' },
		{ username: 'legacy', stable_user_id: null },
	])
	expectInboundUserFkRowsPreserved(db, beforeChildRows)
	expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([])
	expect(
		db
			.prepare(`SELECT sql FROM sqlite_master WHERE name LIKE '_mig0075_%'`)
			.all(),
	).toEqual([])
})
