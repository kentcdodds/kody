import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { adminCreateUserWithPasswordSetup } from './admin-user-creation.ts'
import { adminPasswordSetupTokenExpiryMs } from './password-reset-tokens.ts'
import { getUsernameValidationError } from './username.ts'

const setupLinkOrigin = 'https://kody.example/admin/users'

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const count = (table: string) =>
		(
			sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
				count: number
			}
		).count
	return { sqlite, db: createD1FromSqlite(sqlite), count }
}

test('adminCreateUserWithPasswordSetup rejects duplicate email', async () => {
	const { sqlite, db, count } = createDb()
	sqlite.exec(`
		INSERT INTO users (username, email, password_hash, stable_user_id, email_verified_at)
		VALUES ('existing', 'existing@example.com', 'hash', 'stable-existing', '1970-01-01T00:00:00.000Z')
	`)

	await expect(
		adminCreateUserWithPasswordSetup({
			db,
			email: 'existing@example.com',
			setupLinkOrigin,
		}),
	).rejects.toMatchObject({
		code: 'email_exists',
		message: 'Email already registered.',
	})
	expect(count('password_resets')).toBe(0)
})

test('adminCreateUserWithPasswordSetup creates verified user and seven-day setup link', async () => {
	const now = new Date('2026-07-05T16:00:00.000Z')
	const { sqlite, db } = createDb()

	const created = await adminCreateUserWithPasswordSetup({
		db,
		email: 'Person+Launch@Example.com',
		username: null,
		setupLinkOrigin,
		now,
	})

	expect(created.email).toBe('person+launch@example.com')
	expect(created.username).toBe('person-launch')
	expect(created.setupLink).toMatch(
		/^https:\/\/kody\.example\/reset-password\?token=[0-9a-f]{64}$/,
	)
	const expiresAt = now.getTime() + adminPasswordSetupTokenExpiryMs
	expect(created.setupTokenExpiresAt).toBe(expiresAt)
	expect(
		sqlite
			.prepare(
				`SELECT u.email, u.username, u.email_verified_at, u.password_hash, o.plan
				FROM users u
				INNER JOIN orgs o ON o.id = u.stable_user_id
				WHERE u.id = ?`,
			)
			.get(created.userId),
	).toEqual({
		email: 'person+launch@example.com',
		username: 'person-launch',
		email_verified_at: now.toISOString(),
		password_hash: 'admin_created_no_usable_password',
		plan: 'free',
	})
	expect(
		sqlite
			.prepare(`SELECT expires_at FROM password_resets WHERE user_id = ?`)
			.all(created.userId),
	).toEqual([{ expires_at: expiresAt }])
	expect(
		sqlite
			.prepare(
				`SELECT roles.name FROM user_roles
				JOIN roles ON roles.id = user_roles.role_id
				WHERE user_roles.user_id = ?`,
			)
			.all(created.userId),
	).toEqual([{ name: 'user' }])
	expect(
		sqlite
			.prepare(
				`SELECT id, kind, amount_micro_usd, granted_by_user_id
				 FROM credit_ledger_entries WHERE user_id = ?`,
			)
			.get(created.stableUserId),
	).toEqual({
		id: `signup_welcome:${created.stableUserId}`,
		kind: 'admin_grant',
		amount_micro_usd: 5_000_000,
		granted_by_user_id: null,
	})
	expect(
		sqlite
			.prepare(`SELECT balance_micro_usd FROM credit_wallets WHERE user_id = ?`)
			.get(created.stableUserId),
	).toEqual({ balance_micro_usd: 5_000_000 })
	expect(
		sqlite
			.prepare(
				`SELECT signup_welcome_credits_pending AS pending
				 FROM orgs WHERE id = ?`,
			)
			.get(created.stableUserId),
	).toEqual({ pending: 0 })
})

test('adminCreateUserWithPasswordSetup rejects explicit reserved usernames and skips reserved generated ones', async () => {
	const explicit = createDb()
	await expect(
		adminCreateUserWithPasswordSetup({
			db: explicit.db,
			email: 'person@example.com',
			username: 'postmaster',
			setupLinkOrigin,
		}),
	).rejects.toMatchObject({
		code: 'invalid_username',
		message: 'This username is reserved.',
	})
	expect(explicit.count('users')).toBe(0)

	// A generated username derived from a reserved email local part must not
	// keep that token (`support-2` still contains `support`).
	const created = await adminCreateUserWithPasswordSetup({
		db: createDb().db,
		email: 'support@example.com',
		username: null,
		setupLinkOrigin,
	})
	expect(created.username.includes('support')).toBe(false)
	expect(getUsernameValidationError(created.username)).toBeNull()
})
