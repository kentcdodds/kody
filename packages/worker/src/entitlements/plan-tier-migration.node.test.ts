import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const baselineSql = readFileSync(
	new URL('0001-squashed-init.sql', migrationsDirectory),
	'utf8',
)
const tierMigrationSql = readFileSync(
	new URL('0002-restructure-plan-tiers.sql', migrationsDirectory),
	'utf8',
)

function insertUser(
	db: DatabaseSync,
	input: { id: number; plan: string; stripePlan: string | null },
) {
	db.prepare(
		`INSERT INTO users (
			id, username, email, password_hash, plan, stable_user_id, stripe_plan
		) VALUES (?, ?, ?, 'hash', ?, ?, ?)`,
	).run(
		input.id,
		`user-${input.id}`,
		`user-${input.id}@example.com`,
		input.plan,
		`stable-${input.id}`,
		input.stripePlan,
	)
}

test('tier migration renames stored plans, rebuilds checks, and preserves references', () => {
	const db = new DatabaseSync(':memory:')
	db.exec(baselineSql)
	insertUser(db, { id: 10, plan: 'pro', stripePlan: 'partner' })
	insertUser(db, { id: 20, plan: 'partner', stripePlan: 'pro' })
	db.prepare(
		`INSERT INTO invites (code, created_by, plan)
		 VALUES ('old-pro', 10, 'pro'), ('old-partner', 20, 'partner')`,
	).run()
	db.prepare(`INSERT INTO user_roles (user_id, role_id) VALUES (10, 1)`).run()

	db.exec(tierMigrationSql)

	expect(
		db.prepare(`SELECT id, plan, stripe_plan FROM users ORDER BY id`).all(),
	).toEqual([
		{ id: 10, plan: 'standard', stripe_plan: 'pro' },
		{ id: 20, plan: 'pro', stripe_plan: 'standard' },
	])
	expect(
		db.prepare(`SELECT code, plan FROM invites ORDER BY code`).all(),
	).toEqual([
		{ code: 'old-partner', plan: 'pro' },
		{ code: 'old-pro', plan: 'standard' },
	])
	expect(db.prepare(`SELECT user_id, role_id FROM user_roles`).get()).toEqual({
		user_id: 10,
		role_id: 1,
	})
	expect(
		String(
			db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'users'`).get()
				?.sql,
		),
	).toContain(`plan IN ('free', 'standard', 'pro', 'max')`)
	expect(() =>
		insertUser(db, { id: 30, plan: 'partner', stripePlan: null }),
	).toThrow(/CHECK constraint failed/)
})

test('tier migration fails closed before destructive work on unknown values', () => {
	const db = new DatabaseSync(':memory:')
	db.exec(baselineSql)
	db.exec(`PRAGMA ignore_check_constraints = ON`)
	insertUser(db, {
		id: 10,
		plan: 'enterprise-2099',
		stripePlan: null,
	})
	db.exec(`PRAGMA ignore_check_constraints = OFF`)

	expect(() => db.exec(tierMigrationSql)).toThrow(/CHECK constraint failed/)
	expect(db.prepare(`SELECT plan FROM users WHERE id = 10`).get()).toEqual({
		plan: 'enterprise-2099',
	})
})
