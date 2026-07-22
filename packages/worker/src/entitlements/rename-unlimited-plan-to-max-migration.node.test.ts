import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

/** Upper bound (exclusive): only migrations before this file are applied as setup. */
const renameUnlimitedPlanToMaxMigration =
	'0082-rename-unlimited-plan-to-max.sql'

/** D1 wraps each migration file in a transaction; mirror that in rollback tests. */
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

function applyMigrationsBeforeRename(db: DatabaseSync) {
	db.exec('PRAGMA foreign_keys = ON')
	for (const fileName of readdirSync(migrationsDirectory)
		.filter(
			(file) =>
				file.endsWith('.sql') && file < renameUnlimitedPlanToMaxMigration,
		)
		.sort()) {
		db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
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

/**
 * Seed after migrations through 0081: plan is NOT NULL DEFAULT 'unlimited'.
 * Covers max/unlimited/pro/free/partner/unknown on users + invites, with
 * varied stripe_plan values including literal 'unlimited' that must stay put.
 */
function seedPlanRows(db: DatabaseSync) {
	db.exec(`
		INSERT INTO users (
			id, username, email, password_hash, stable_user_id, plan, stripe_plan
		) VALUES
			(
				1, 'max-user', 'max@example.com', 'hash-m', 'stable-max',
				'max', 'pro'
			),
			(
				2, 'unlimited-user', 'unlimited@example.com', 'hash-u', 'stable-unlimited',
				'unlimited', 'free'
			),
			(
				3, 'pro-user', 'pro@example.com', 'hash-p', 'stable-pro',
				'pro', 'unlimited'
			),
			(
				4, 'free-user', 'free@example.com', 'hash-f', 'stable-free',
				'free', 'pro'
			),
			(
				5, 'partner-user', 'partner@example.com', 'hash-r', 'stable-partner',
				'partner', NULL
			),
			(
				6, 'unknown-user', 'unknown@example.com', 'hash-k', 'stable-unknown',
				'unknown-stored-plan', 'unlimited'
			);

		INSERT INTO invites (code, created_by, note, max_uses, use_count, plan)
		VALUES
			('invite-max', 1, 'already max', 1, 0, 'max'),
			('invite-unlimited', 2, 'manual unlimited', 2, 0, 'unlimited'),
			('invite-pro', 3, 'paid invite', 3, 1, 'pro'),
			('invite-free', 4, 'free invite', 2, 0, 'free'),
			('invite-partner', 5, 'partner invite', 1, 0, 'partner'),
			('invite-unknown', 6, 'unknown stored plan', 4, 2, 'unknown-stored-plan');
	`)
}

test('rename unlimited→max updates only exact plan matches and preserves schema under a D1 transaction', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBeforeRename(db)
	seedPlanRows(db)

	const beforeUsersSql = usersTableSql(db)
	const beforeInvitesSql = invitesTableSql(db)
	const beforeUsersPlan = planColumnInfo(db, 'users')
	const beforeInvitesPlan = planColumnInfo(db, 'invites')

	expect(beforeUsersPlan).toMatchObject({
		notnull: 1,
		dflt_value: "'unlimited'",
	})
	expect(beforeInvitesPlan).toMatchObject({
		notnull: 1,
		dflt_value: "'unlimited'",
	})
	expect(
		db
			.prepare(`SELECT username, plan, stripe_plan FROM users ORDER BY id`)
			.all(),
	).toEqual([
		{ username: 'max-user', plan: 'max', stripe_plan: 'pro' },
		{ username: 'unlimited-user', plan: 'unlimited', stripe_plan: 'free' },
		{ username: 'pro-user', plan: 'pro', stripe_plan: 'unlimited' },
		{ username: 'free-user', plan: 'free', stripe_plan: 'pro' },
		{ username: 'partner-user', plan: 'partner', stripe_plan: null },
		{
			username: 'unknown-user',
			plan: 'unknown-stored-plan',
			stripe_plan: 'unlimited',
		},
	])
	expect(
		db.prepare(`SELECT code, plan FROM invites ORDER BY code`).all(),
	).toEqual([
		{ code: 'invite-free', plan: 'free' },
		{ code: 'invite-max', plan: 'max' },
		{ code: 'invite-partner', plan: 'partner' },
		{ code: 'invite-pro', plan: 'pro' },
		{ code: 'invite-unknown', plan: 'unknown-stored-plan' },
		{ code: 'invite-unlimited', plan: 'unlimited' },
	])

	applyMigrationLikeD1(db, renameUnlimitedPlanToMaxMigration)

	expect(
		db
			.prepare(`SELECT username, plan, stripe_plan FROM users ORDER BY id`)
			.all(),
	).toEqual([
		{ username: 'max-user', plan: 'max', stripe_plan: 'pro' },
		{ username: 'unlimited-user', plan: 'max', stripe_plan: 'free' },
		{ username: 'pro-user', plan: 'pro', stripe_plan: 'unlimited' },
		{ username: 'free-user', plan: 'free', stripe_plan: 'pro' },
		{ username: 'partner-user', plan: 'partner', stripe_plan: null },
		{
			username: 'unknown-user',
			plan: 'unknown-stored-plan',
			stripe_plan: 'unlimited',
		},
	])
	expect(
		db.prepare(`SELECT code, plan FROM invites ORDER BY code`).all(),
	).toEqual([
		{ code: 'invite-free', plan: 'free' },
		{ code: 'invite-max', plan: 'max' },
		{ code: 'invite-partner', plan: 'partner' },
		{ code: 'invite-pro', plan: 'pro' },
		{ code: 'invite-unknown', plan: 'unknown-stored-plan' },
		{ code: 'invite-unlimited', plan: 'max' },
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

	// Data rename only: no table rebuild, DEFAULT, or nullability change.
	expect(usersTableSql(db)).toBe(beforeUsersSql)
	expect(invitesTableSql(db)).toBe(beforeInvitesSql)
	expect(planColumnInfo(db, 'users')).toEqual(beforeUsersPlan)
	expect(planColumnInfo(db, 'invites')).toEqual(beforeInvitesPlan)
	expect(planColumnInfo(db, 'users')).toMatchObject({
		notnull: 1,
		dflt_value: "'unlimited'",
	})
	expect(planColumnInfo(db, 'invites')).toMatchObject({
		notnull: 1,
		dflt_value: "'unlimited'",
	})
	expect(
		db
			.prepare(
				`SELECT sql FROM sqlite_master
				 WHERE name = '__migration_assertions'
				    OR name LIKE '_mig0082_%'`,
			)
			.all(),
	).toEqual([])
	expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([])
})

test('rename unlimited→max fails closed and rolls back when a residual unlimited plan remains', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBeforeRename(db)
	seedPlanRows(db)

	const beforeUsers = db
		.prepare(`SELECT username, plan, stripe_plan FROM users ORDER BY id`)
		.all()
	const beforeInvites = db
		.prepare(`SELECT code, plan FROM invites ORDER BY code`)
		.all()
	const beforeUsersSql = usersTableSql(db)
	const beforeInvitesSql = invitesTableSql(db)

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

	expect(() =>
		applyMigrationLikeD1(db, renameUnlimitedPlanToMaxMigration),
	).toThrow(/CHECK constraint failed: 0/)

	// Whole migration transaction rolled back: invites UPDATE undone too.
	expect(
		db
			.prepare(`SELECT username, plan, stripe_plan FROM users ORDER BY id`)
			.all(),
	).toEqual(beforeUsers)
	expect(
		db.prepare(`SELECT code, plan FROM invites ORDER BY code`).all(),
	).toEqual(beforeInvites)
	expect(
		db
			.prepare(
				`SELECT sql FROM sqlite_master
				 WHERE name = '__migration_assertions'`,
			)
			.all(),
	).toEqual([])
	expect(usersTableSql(db)).toBe(beforeUsersSql)
	expect(invitesTableSql(db)).toBe(beforeInvitesSql)
	expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([])
})
