import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const planCheckMigration = '0113-plan-check-constraints.sql'

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

function applyMigrationsBefore(db: DatabaseSync, exclusiveUpperBound: string) {
	db.exec('PRAGMA foreign_keys = ON')
	for (const fileName of readdirSync(migrationsDirectory)
		.filter((file) => file.endsWith('.sql') && file < exclusiveUpperBound)
		.sort()) {
		db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
	}
}

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

function tableSql(db: DatabaseSync, tableName: 'users' | 'invites') {
	const row = db
		.prepare(
			`SELECT sql FROM sqlite_master
			 WHERE type = 'table' AND name = ?`,
		)
		.get(tableName) as { sql: string } | undefined
	return row?.sql ?? ''
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
	return listLiveTables(db)
		.filter((tableName) =>
			(
				db.prepare(`PRAGMA foreign_key_list(${tableName})`).all() as Array<{
					table: string
				}>
			).some((foreignKey) => foreignKey.table === 'users'),
		)
		.sort()
}

function seedValidPlansAndReferences(db: DatabaseSync) {
	db.exec(`
		INSERT INTO users (
			id, username, email, password_hash, created_at, updated_at,
			email_verified_at, plan, stable_user_id, stripe_customer_id,
			stripe_plan, stripe_plan_refreshed_at, display_name, bio,
			profile_visibility, avatar_key, account_type, deleting_at,
			active_write_count, active_write_expires_at, suspended_at,
			email_outbound_paused_at, password_changed_at,
			job_retention_success_once_days, job_retention_failed_once_days,
			job_retention_disabled_recurring_days
		) VALUES
			(
				1, 'free-user', 'free@example.com', 'hash-free', '2026-07-01',
				'2026-07-02', '2026-07-03', 'free', 'stable-free', 'cus_free',
				'pro', '2026-07-04', 'Free User', 'Bio', 'private',
				'user-avatars/free/avatar.png', 'person', '2026-07-05', 2,
				'2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09',
				14, 60, 90
			),
			(
				2, 'partner-user', 'partner@example.com', 'hash-partner',
				'2026-07-01', '2026-07-01', NULL, 'partner', 'stable-partner',
				NULL, NULL, NULL, NULL, NULL, 'public', NULL, 'person', NULL, 0,
				NULL, NULL, NULL, NULL, NULL, NULL, NULL
			),
			(
				3, 'pro-user', 'pro@example.com', 'hash-pro', '2026-07-01',
				'2026-07-01', NULL, 'pro', 'stable-pro', NULL, NULL, NULL, NULL,
				NULL, 'public', NULL, 'person', NULL, 0, NULL, NULL, NULL, NULL,
				NULL, NULL, NULL
			),
			(
				4, 'max-user', 'max@example.com', 'hash-max', '2026-07-01',
				'2026-07-01', NULL, 'max', 'stable-max', NULL, NULL, NULL, NULL,
				NULL, 'public', NULL, 'platform', NULL, 0, NULL, NULL, NULL, NULL,
				NULL, NULL, NULL
			);

		INSERT INTO invites (
			code, created_by, note, max_uses, use_count, expires_at, revoked_at,
			created_at, plan
		) VALUES
			('FREE', 1, 'free', 1, 0, NULL, NULL, '2026-07-01', 'free'),
			('PARTNER', 2, 'partner', 2, 1, '2026-08-01', NULL, '2026-07-01', 'partner'),
			('PRO', 3, 'pro', 1, 0, NULL, NULL, '2026-07-01', 'pro'),
			('MAX', 4, 'max', 1, 0, NULL, '2026-07-10', '2026-07-01', 'max');

		INSERT INTO password_resets (id, user_id, token_hash, expires_at)
		VALUES (11, 1, 'reset-hash', 999999);
		INSERT INTO email_verifications (id, user_id, token_hash, expires_at)
		VALUES (21, 1, 'verify-hash', 999999);
		INSERT INTO pending_email_changes (
			id, user_id, new_email, token_hash, expires_at
		) VALUES (31, 1, 'next@example.com', 'change-hash', 999999);
		INSERT INTO passkeys (
			id, aaguid, public_key, user_id, webauthn_user_handle, counter,
			device_type, backed_up, transports, name
		) VALUES (
			'passkey-1', 'aaguid', 'public-key', 1, 'handle', 0, 'platform', 1,
			'internal', 'Laptop'
		);
		INSERT INTO oauth_connections (
			id, user_id, provider_name, provider_id, provider_display_name
		) VALUES (41, 1, 'github', 'github-1', 'free-user');
		INSERT INTO user_roles (user_id, role_id)
		SELECT 1, id FROM roles WHERE name = 'user';
		INSERT INTO feature_flags (key, enabled, rollout_percent, note, updated_by)
		VALUES ('plan-check', 1, 100, 'test', 1);
		INSERT INTO feature_flag_user_overrides (
			flag_key, user_id, enabled, updated_by
		) VALUES ('plan-check', 1, 1, 2);
	`)
}

test('0113 preserves current users/invites data and enforces registered plan checks', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, planCheckMigration)
	seedValidPlansAndReferences(db)
	db.prepare(
		`INSERT INTO users (
			id, username, email, password_hash, stable_user_id, plan
		) VALUES (
			1000, 'high-water', 'high-water@example.com', 'hash',
			'stable-high-water', 'free'
		)`,
	).run()
	db.prepare(`DELETE FROM users WHERE id = 1000`).run()

	const usersBefore = db.prepare(`SELECT * FROM users ORDER BY id`).all()
	const invitesBefore = db.prepare(`SELECT * FROM invites ORDER BY code`).all()
	const passwordResetsBefore = db
		.prepare(`SELECT * FROM password_resets ORDER BY id`)
		.all()
	expect(tablesWithForeignKeyToUsers(db)).toEqual(
		[...inboundUserFkTables].sort(),
	)

	applyMigrationLikeD1(db, planCheckMigration)

	expect(db.prepare(`SELECT * FROM users ORDER BY id`).all()).toEqual(
		usersBefore,
	)
	expect(db.prepare(`SELECT * FROM invites ORDER BY code`).all()).toEqual(
		invitesBefore,
	)
	expect(db.prepare(`SELECT * FROM password_resets ORDER BY id`).all()).toEqual(
		passwordResetsBefore,
	)
	expect(tableSql(db, 'users')).toMatch(
		/plan TEXT NOT NULL DEFAULT 'free' CHECK \(\s*plan IN \('free', 'partner', 'pro', 'max'\)\s*\)/,
	)
	expect(tableSql(db, 'invites')).toMatch(
		/plan TEXT NOT NULL DEFAULT 'free' CHECK \(\s*plan IN \('free', 'partner', 'pro', 'max'\)\s*\)/,
	)
	expect(tableSql(db, 'users')).not.toMatch(/stripe_plan TEXT[^,\n]*CHECK/)
	expect(() =>
		db
			.prepare(
				`INSERT INTO users (
					username, email, password_hash, stable_user_id, plan
				) VALUES (
					'invalid-user', 'invalid@example.com', 'hash', 'stable-invalid',
					'enterprise'
				)`,
			)
			.run(),
	).toThrow(/CHECK constraint failed/)
	expect(() =>
		db
			.prepare(
				`INSERT INTO invites (code, note, plan)
				 VALUES ('INVALID', 'invalid', 'unlimited')`,
			)
			.run(),
	).toThrow(/CHECK constraint failed/)
	db.prepare(
		`INSERT INTO users (username, email, password_hash, stable_user_id)
		 VALUES ('default-user', 'default@example.com', 'hash', 'stable-default')`,
	).run()
	expect(
		db
			.prepare(`SELECT id, plan FROM users WHERE username = 'default-user'`)
			.get(),
	).toEqual({ id: 1001, plan: 'free' })
	db.prepare(
		`INSERT INTO invites (code, note) VALUES ('DEFAULT', 'default')`,
	).run()
	expect(
		db.prepare(`SELECT plan FROM invites WHERE code = 'DEFAULT'`).get(),
	).toEqual({ plan: 'free' })
	expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([])
	expect(tablesWithForeignKeyToUsers(db)).toEqual(
		[...inboundUserFkTables].sort(),
	)
	expect(
		db
			.prepare(
				`SELECT name FROM sqlite_master
				 WHERE name LIKE '_mig0113_%'
				    OR name = '__migration_assertions'
				    OR name LIKE '%_next'`,
			)
			.all(),
	).toEqual([])
})

test('0113 aborts without coercion for invalid users and invites plan values', () => {
	for (const invalidTable of ['users', 'invites'] as const) {
		const db = new DatabaseSync(':memory:')
		applyMigrationsBefore(db, planCheckMigration)
		seedValidPlansAndReferences(db)
		if (invalidTable === 'users') {
			db.prepare(`UPDATE users SET plan = 'enterprise' WHERE id = 1`).run()
		} else {
			db.prepare(
				`UPDATE invites SET plan = 'unlimited' WHERE code = 'FREE'`,
			).run()
		}
		const usersBefore = db.prepare(`SELECT * FROM users ORDER BY id`).all()
		const invitesBefore = db
			.prepare(`SELECT * FROM invites ORDER BY code`)
			.all()
		const usersSqlBefore = tableSql(db, 'users')
		const invitesSqlBefore = tableSql(db, 'invites')

		expect(() => applyMigrationLikeD1(db, planCheckMigration)).toThrow(
			/CHECK constraint failed: 0/,
		)
		expect(db.prepare(`SELECT * FROM users ORDER BY id`).all()).toEqual(
			usersBefore,
		)
		expect(db.prepare(`SELECT * FROM invites ORDER BY code`).all()).toEqual(
			invitesBefore,
		)
		expect(tableSql(db, 'users')).toBe(usersSqlBefore)
		expect(tableSql(db, 'invites')).toBe(invitesSqlBefore)
		expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([])
		expect(
			db
				.prepare(
					`SELECT name FROM sqlite_master
					 WHERE name LIKE '_mig0113_%'
					    OR name = '__migration_assertions'
					    OR name LIKE '%_next'`,
				)
				.all(),
		).toEqual([])
	}
})
