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
const ladderMigrationSql = readFileSync(
	new URL('0043-users-entitlement-ladder.sql', migrationsDirectory),
	'utf8',
)

function insertUser(
	db: DatabaseSync,
	input: {
		id: number
		plan: string
		stripePlan: string | null
		deletingAt?: string | null
	},
) {
	db.prepare(
		`INSERT INTO users (
			id, username, email, password_hash, plan, stable_user_id, stripe_plan,
			deleting_at
		) VALUES (?, ?, ?, 'hash', ?, ?, ?, ?)`,
	).run(
		input.id,
		`user-${input.id}`,
		`user-${input.id}@example.com`,
		input.plan,
		`stable-${input.id}`,
		input.stripePlan,
		input.deletingAt ?? null,
	)
}

test('entitlement ladder backfill flags active Stripe Standard/Pro and manual Pro', () => {
	const db = new DatabaseSync(':memory:')
	db.exec(baselineSql)
	db.exec(tierMigrationSql)
	insertUser(db, { id: 10, plan: 'free', stripePlan: 'standard' })
	insertUser(db, { id: 20, plan: 'free', stripePlan: 'pro' })
	insertUser(db, { id: 30, plan: 'pro', stripePlan: null })
	insertUser(db, { id: 40, plan: 'free', stripePlan: null })
	insertUser(db, { id: 50, plan: 'max', stripePlan: null })
	insertUser(db, {
		id: 60,
		plan: 'free',
		stripePlan: 'standard',
		deletingAt: '2026-09-01T00:00:00.000Z',
	})

	db.exec(ladderMigrationSql)

	expect(
		db.prepare(`SELECT id, entitlement_ladder FROM users ORDER BY id`).all(),
	).toEqual([
		{ id: 10, entitlement_ladder: 'legacy' },
		{ id: 20, entitlement_ladder: 'legacy' },
		{ id: 30, entitlement_ladder: 'legacy' },
		{ id: 40, entitlement_ladder: 'public' },
		{ id: 50, entitlement_ladder: 'public' },
		{ id: 60, entitlement_ladder: 'public' },
	])
	expect(() =>
		db
			.prepare(`UPDATE users SET entitlement_ladder = 'v1' WHERE id = 40`)
			.run(),
	).toThrow(/CHECK constraint failed/)
})
