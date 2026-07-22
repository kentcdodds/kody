import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import {
	createStableUserIdFromEmail,
	normalizeStableUserId,
	resolveUserStableId,
} from './user-id.ts'

type UsersStableIdRow = {
	id: number
	email: string
	stable_user_id: string
}

async function recreateUsersTable(db: D1Database) {
	await db.prepare(`DROP TABLE IF EXISTS users`).run()
	await db
		.prepare(
			`CREATE TABLE users (
	id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	username TEXT NOT NULL UNIQUE,
	email TEXT NOT NULL UNIQUE,
	password_hash TEXT NOT NULL,
	stable_user_id TEXT NOT NULL
)`,
		)
		.run()
	await db
		.prepare(
			`CREATE UNIQUE INDEX idx_users_stable_user_id
	ON users(stable_user_id)`,
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

async function findUserByStableUserId(
	db: D1Database,
	stableUserId: string,
): Promise<UsersStableIdRow | null> {
	const trimmed = normalizeStableUserId(stableUserId)
	if (!trimmed) return null
	return (
		(await db
			.prepare(
				`SELECT id, email, stable_user_id
				 FROM users
				 WHERE stable_user_id = ?`,
			)
			.bind(trimmed)
			.first<UsersStableIdRow>()) ?? null
	)
}

test('indexed stable ids resolve and email-change ids stay authoritative', async () => {
	await recreateUsersTable(env.APP_DB)
	// A stored id that differs from the email hash (the email changed after
	// signup) must stay authoritative.
	const email = `changed-${crypto.randomUUID()}@example.com`
	const storedStableUserId = crypto.randomUUID().replaceAll('-', '')
	await seedUser({
		db: env.APP_DB,
		email,
		stableUserId: storedStableUserId,
	})

	const row = await findUserByStableUserId(env.APP_DB, storedStableUserId)
	expect(row?.email).toBe(email)
	expect(row?.stable_user_id).toBe(storedStableUserId)
	expect(resolveUserStableId(row!)).toBe(storedStableUserId)
	expect(await createStableUserIdFromEmail(email)).not.toBe(storedStableUserId)

	expect(
		await findUserByStableUserId(env.APP_DB, `missing-${storedStableUserId}`),
	).toBeNull()
})

test('signup-derived stable ids resolve via the unique index', async () => {
	await recreateUsersTable(env.APP_DB)
	const email = `signup-${crypto.randomUUID()}@example.com`
	const stableUserId = await createStableUserIdFromEmail(email)
	await seedUser({ db: env.APP_DB, email, stableUserId })

	const row = await findUserByStableUserId(env.APP_DB, stableUserId)
	expect(row?.email).toBe(email)
	expect(row?.stable_user_id).toBe(stableUserId)
})
