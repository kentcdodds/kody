import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import {
	createStableUserIdFromEmail,
	findUserRowByStableUserId,
} from './user-id.ts'

const usersSelect = `SELECT id, email, stable_user_id FROM users`

async function recreateUsersTable(input: {
	db: D1Database
	withStableUserIdColumn: boolean
}) {
	await input.db.prepare(`DROP TABLE IF EXISTS users`).run()
	await input.db
		.prepare(
			`CREATE TABLE users (
	id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	username TEXT NOT NULL UNIQUE,
	email TEXT NOT NULL UNIQUE,
	password_hash TEXT NOT NULL${
		input.withStableUserIdColumn ? ',\n\tstable_user_id TEXT' : ''
	}
)`,
		)
		.run()
	if (input.withStableUserIdColumn) {
		// Mirrors migration 0052.
		await input.db
			.prepare(
				`CREATE UNIQUE INDEX idx_users_stable_user_id
	ON users(stable_user_id)
	WHERE stable_user_id IS NOT NULL`,
			)
			.run()
	}
}

async function seedUser(input: {
	db: D1Database
	email: string
	stableUserId?: string | null
}) {
	await input.db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			VALUES (?, ?, 'test-password-hash', ?)`,
		)
		.bind(
			`user-id-${crypto.randomUUID().slice(0, 8)}`,
			input.email,
			input.stableUserId ?? null,
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

test('scan fallback heals NULL stable_user_id rows with a write-back', async () => {
	await recreateUsersTable({ db: env.APP_DB, withStableUserIdColumn: true })
	const emailA = `legacy-a-${crypto.randomUUID()}@example.com`
	const emailB = `legacy-b-${crypto.randomUUID()}@example.com`
	await seedUser({ db: env.APP_DB, email: emailA })
	await seedUser({ db: env.APP_DB, email: emailB })
	const stableUserIdB = await createStableUserIdFromEmail(emailB)

	const row = await findUserRowByStableUserId({
		db: env.APP_DB,
		stableUserId: stableUserIdB,
		select: usersSelect,
	})
	expect(row?.email).toBe(emailB)

	// The matched legacy row got its computed stable id persisted; the
	// non-matching row was left alone.
	expect(await readStoredStableUserId(env.APP_DB, emailB)).toBe(stableUserIdB)
	expect(await readStoredStableUserId(env.APP_DB, emailA)).toBeNull()

	// The healed row is now found via the indexed point read.
	const healedRow = await findUserRowByStableUserId({
		db: env.APP_DB,
		stableUserId: stableUserIdB,
		select: usersSelect,
	})
	expect(healedRow?.email).toBe(emailB)
	expect(healedRow?.stable_user_id).toBe(stableUserIdB)
})

test('stored stable ids resolve via the index and are never overwritten', async () => {
	await recreateUsersTable({ db: env.APP_DB, withStableUserIdColumn: true })
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

test('pre-migration databases without the column still resolve via the scan', async () => {
	await recreateUsersTable({ db: env.APP_DB, withStableUserIdColumn: false })
	const email = `pre-migration-${crypto.randomUUID()}@example.com`
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash)
		VALUES (?, ?, 'test-password-hash')`,
	)
		.bind(`user-id-${crypto.randomUUID().slice(0, 8)}`, email)
		.run()

	// The write-back UPDATE fails on the missing column and is swallowed.
	const row = await findUserRowByStableUserId({
		db: env.APP_DB,
		stableUserId: await createStableUserIdFromEmail(email),
		select: usersSelect,
	})
	expect(row?.email).toBe(email)
})
