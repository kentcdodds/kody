import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

/** Upper bound (exclusive): only migrations before this file are applied as setup. */
const unlimitedPlanBackfillMigration = '0080-backfill-unlimited-plan.sql'

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

function applyMigrationsBeforeBackfill(db: DatabaseSync) {
	db.exec('PRAGMA foreign_keys = ON')
	for (const fileName of readdirSync(migrationsDirectory)
		.filter(
			(file) => file.endsWith('.sql') && file < unlimitedPlanBackfillMigration,
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

function seedPlanRows(db: DatabaseSync) {
	db.exec(`
		INSERT INTO users (
			id, username, email, password_hash, stable_user_id, plan, stripe_plan
		) VALUES
			(
				1, 'null-plan-user', 'null-plan@example.com', 'hash-l', 'stable-null-plan',
				NULL, 'pro'
			),
			(
				2, 'paid', 'paid@example.com', 'hash-p', 'stable-paid',
				'pro', 'free'
			),
			(
				3, 'partner', 'partner@example.com', 'hash-r', 'stable-partner',
				'partner', NULL
			),
			(
				4, 'free', 'free@example.com', 'hash-f', 'stable-free',
				'free', 'pro'
			);

		INSERT INTO invites (code, created_by, note, max_uses, use_count, plan)
		VALUES
			('invite-null', 1, 'null-plan invite', 1, 0, NULL),
			('invite-pro', 2, 'paid invite', 3, 1, 'pro'),
			('invite-free', 4, 'free invite', 2, 0, 'free');
	`)
}

test('unlimited plan backfill materializes NULL plans and preserves enforcement-bearing rows under a D1 transaction', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBeforeBackfill(db)
	seedPlanRows(db)

	expect(usersTableSql(db)).toMatch(/plan TEXT DEFAULT NULL/)
	expect(usersTableSql(db)).not.toMatch(/plan TEXT NOT NULL/)
	expect(invitesTableSql(db)).toContain('plan')
	expect(
		db
			.prepare(`SELECT username, plan, stripe_plan FROM users ORDER BY id`)
			.all(),
	).toEqual([
		{ username: 'null-plan-user', plan: null, stripe_plan: 'pro' },
		{ username: 'paid', plan: 'pro', stripe_plan: 'free' },
		{ username: 'partner', plan: 'partner', stripe_plan: null },
		{ username: 'free', plan: 'free', stripe_plan: 'pro' },
	])
	expect(
		db.prepare(`SELECT code, plan FROM invites ORDER BY code`).all(),
	).toEqual([
		{ code: 'invite-free', plan: 'free' },
		{ code: 'invite-null', plan: null },
		{ code: 'invite-pro', plan: 'pro' },
	])

	applyMigrationLikeD1(db, unlimitedPlanBackfillMigration)

	expect(
		db
			.prepare(`SELECT username, plan, stripe_plan FROM users ORDER BY id`)
			.all(),
	).toEqual([
		{ username: 'null-plan-user', plan: 'unlimited', stripe_plan: 'pro' },
		{ username: 'paid', plan: 'pro', stripe_plan: 'free' },
		{ username: 'partner', plan: 'partner', stripe_plan: null },
		{ username: 'free', plan: 'free', stripe_plan: 'pro' },
	])
	expect(
		db.prepare(`SELECT code, plan FROM invites ORDER BY code`).all(),
	).toEqual([
		{ code: 'invite-free', plan: 'free' },
		{ code: 'invite-null', plan: 'unlimited' },
		{ code: 'invite-pro', plan: 'pro' },
	])
	expect(
		db.prepare(`SELECT COUNT(*) AS count FROM users WHERE plan IS NULL`).get(),
	).toEqual({ count: 0 })
	expect(
		db
			.prepare(`SELECT COUNT(*) AS count FROM invites WHERE plan IS NULL`)
			.get(),
	).toEqual({ count: 0 })

	// Stage 1 keeps nullable columns and does not rebuild tables.
	expect(usersTableSql(db)).toMatch(/plan TEXT DEFAULT NULL/)
	expect(usersTableSql(db)).not.toMatch(/plan TEXT NOT NULL/)
	expect(
		db
			.prepare(
				`SELECT sql FROM sqlite_master
				 WHERE name = '__migration_assertions'
				    OR name LIKE '_mig0080_%'`,
			)
			.all(),
	).toEqual([])
	expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([])
})

test('unlimited plan backfill fails closed and rolls back when a residual NULL plan remains', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBeforeBackfill(db)
	seedPlanRows(db)

	const beforeUsers = db
		.prepare(`SELECT username, plan, stripe_plan FROM users ORDER BY id`)
		.all()
	const beforeInvites = db
		.prepare(`SELECT code, plan FROM invites ORDER BY code`)
		.all()

	// Force one eligible users.plan NULL to survive the real UPDATE so the
	// migration's residual-NULL assertion aborts. Created outside the D1-style
	// migration transaction so the ignore behavior persists through rollback.
	db.exec(`
		CREATE TRIGGER test_keep_null_plan_user
		BEFORE UPDATE OF plan ON users
		WHEN OLD.id = 1 AND OLD.plan IS NULL
		BEGIN
			SELECT RAISE(IGNORE);
		END;
	`)

	expect(() =>
		applyMigrationLikeD1(db, unlimitedPlanBackfillMigration),
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
	expect(usersTableSql(db)).toMatch(/plan TEXT DEFAULT NULL/)
	expect(usersTableSql(db)).not.toMatch(/plan TEXT NOT NULL/)
	expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([])
})
