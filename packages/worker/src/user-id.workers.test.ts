import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import {
	createStableUserIdFromEmail,
	findUserRowByStableUserId,
	resolveUserStableId,
} from './user-id.ts'

const usersSelect = `SELECT id, email, stable_user_id FROM users`

async function recreateUsersTable(db: D1Database) {
	await db.prepare(`DROP TABLE IF EXISTS users`).run()
	await db
		.prepare(
			`CREATE TABLE users (
	id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	username TEXT NOT NULL UNIQUE,
	email TEXT NOT NULL UNIQUE,
	password_hash TEXT NOT NULL,
	stable_user_id TEXT
)`,
		)
		.run()
	await db
		.prepare(
			`CREATE UNIQUE INDEX idx_users_stable_user_id
	ON users(stable_user_id)
	WHERE stable_user_id IS NOT NULL`,
		)
		.run()
}

async function seedUser(input: {
	db: D1Database
	email: string
	stableUserId: string
}) {
	await input.db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			VALUES (?, ?, 'test-password-hash', ?)`,
		)
		.bind(
			`user-id-${crypto.randomUUID().slice(0, 8)}`,
			input.email,
			input.stableUserId,
		)
		.run()
}

async function readStoredStableUserId(db: D1Database, email: string) {
	const row = await db
		.prepare(`SELECT stable_user_id FROM users WHERE email = ?`)
		.bind(email)
		.first<{ stable_user_id: string | null }>()
	return row?.stable_user_id ?? null
}

test('runtime identity resolution requires a materialized stable id', () => {
	expect(() =>
		resolveUserStableId({
			email: `missing-${crypto.randomUUID()}@example.com`,
			stable_user_id: null,
		}),
	).toThrow('users.stable_user_id must be materialized')
})

test('stored stable ids resolve via the index and are never overwritten', async () => {
	await recreateUsersTable(env.APP_DB)
	// A stored id that differs from the email hash (the email changed after
	// signup) must stay authoritative.
	const email = `changed-${crypto.randomUUID()}@example.com`
	const storedStableUserId = crypto.randomUUID().replaceAll('-', '')
	await seedUser({ db: env.APP_DB, email, stableUserId: storedStableUserId })

	const row = await findUserRowByStableUserId({
		db: env.APP_DB,
		stableUserId: storedStableUserId,
		select: usersSelect,
	})
	expect(row?.email).toBe(email)
	expect(await readStoredStableUserId(env.APP_DB, email)).toBe(
		storedStableUserId,
	)

	expect(
		await findUserRowByStableUserId({
			db: env.APP_DB,
			stableUserId: `missing-${storedStableUserId}`,
			select: usersSelect,
		}),
	).toBeNull()
})
