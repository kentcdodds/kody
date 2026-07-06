import { expect, test } from 'vitest'
import {
	adminCreateUserWithPasswordSetup,
	AdminCreateUserError,
} from './admin-user-creation.ts'
import { adminPasswordSetupTokenExpiryMs } from './password-reset-tokens.ts'

type TestUser = {
	id: number
	username: string
	email: string
	password_hash: string
	email_verified_at: string | null
}

type TestPasswordReset = {
	user_id: number
	token_hash: string
	expires_at: number
}

function createAdminUserCreationTestDb(initialUsers: Array<TestUser> = []) {
	let nextId = Math.max(0, ...initialUsers.map((user) => user.id)) + 1
	const users = new Map(initialUsers.map((user) => [user.id, { ...user }]))
	const passwordResets = new Map<number, TestPasswordReset>()
	const userRoles = new Set<string>()

	const db = {
		prepare(query: string) {
			const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(...params: Array<unknown>) {
					return {
						async first<T>() {
							if (
								normalizedQuery.includes('select id from users where email')
							) {
								const email = String(params[0] ?? '').toLowerCase()
								const user =
									Array.from(users.values()).find(
										(row) => row.email.toLowerCase() === email,
									) ?? null
								return user ? ({ id: user.id } as T) : null
							}
							if (
								normalizedQuery.includes('select id from users where username')
							) {
								const username = String(params[0] ?? '').toLowerCase()
								const user =
									Array.from(users.values()).find(
										(row) => row.username.toLowerCase() === username,
									) ?? null
								return user ? ({ id: user.id } as T) : null
							}
							return null
						},
						async run() {
							if (normalizedQuery.startsWith('insert into users')) {
								const [username, email, passwordHash, emailVerifiedAt] =
									params as Array<string>
								if (
									Array.from(users.values()).some(
										(row) =>
											row.email.toLowerCase() === String(email).toLowerCase(),
									)
								) {
									throw new Error('UNIQUE constraint failed: users.email')
								}
								if (
									Array.from(users.values()).some(
										(row) =>
											row.username.toLowerCase() ===
											String(username).toLowerCase(),
									)
								) {
									throw new Error('UNIQUE constraint failed: users.username')
								}
								const user = {
									id: nextId,
									username: String(username),
									email: String(email),
									password_hash: String(passwordHash),
									email_verified_at: String(emailVerifiedAt),
								}
								nextId += 1
								users.set(user.id, user)
								return { meta: { changes: 1, last_row_id: user.id } }
							}
							if (
								normalizedQuery.includes('insert or ignore into user_roles')
							) {
								const userId = Number(params[0])
								const roleName = String(params[1])
								userRoles.add(`${userId}:${roleName}`)
								return { meta: { changes: 1, last_row_id: 0 } }
							}
							if (normalizedQuery.startsWith('delete from password_resets')) {
								passwordResets.delete(Number(params[0]))
								return { meta: { changes: 1, last_row_id: 0 } }
							}
							if (normalizedQuery.startsWith('insert into password_resets')) {
								const [userId, tokenHash, expiresAt] = params
								passwordResets.set(Number(userId), {
									user_id: Number(userId),
									token_hash: String(tokenHash),
									expires_at: Number(expiresAt),
								})
								return { meta: { changes: 1, last_row_id: 1 } }
							}
							if (normalizedQuery.startsWith('delete from users')) {
								const deleted = users.delete(Number(params[0]))
								return { meta: { changes: deleted ? 1 : 0, last_row_id: 0 } }
							}
							return { meta: { changes: 0, last_row_id: 0 } }
						},
					}
				},
			}
		},
		async exec() {
			return
		},
	} as unknown as D1Database

	return { db, users, passwordResets, userRoles }
}

test('adminCreateUserWithPasswordSetup rejects duplicate email', async () => {
	const { db, passwordResets } = createAdminUserCreationTestDb([
		{
			id: 1,
			username: 'existing',
			email: 'existing@example.com',
			password_hash: 'hash',
			email_verified_at: new Date(0).toISOString(),
		},
	])

	await expect(
		adminCreateUserWithPasswordSetup({
			db,
			email: 'existing@example.com',
			setupLinkOrigin: 'https://kody.example/admin/invites',
		}),
	).rejects.toMatchObject({
		code: 'email_exists',
		message: 'Email already registered.',
	})
	await expect(
		adminCreateUserWithPasswordSetup({
			db,
			email: 'existing@example.com',
			setupLinkOrigin: 'https://kody.example/admin/invites',
		}),
	).rejects.toBeInstanceOf(AdminCreateUserError)
	expect(passwordResets.size).toBe(0)
})

test('adminCreateUserWithPasswordSetup creates verified user and seven-day setup link', async () => {
	const now = new Date('2026-07-05T16:00:00.000Z')
	const { db, users, passwordResets, userRoles } =
		createAdminUserCreationTestDb()

	const created = await adminCreateUserWithPasswordSetup({
		db,
		email: 'Person+Launch@Example.com',
		username: null,
		setupLinkOrigin: 'https://kody.example/admin/invites',
		now,
	})

	expect(created.email).toBe('person+launch@example.com')
	expect(created.username).toBe('person-launch')
	expect(created.setupLink).toMatch(
		/^https:\/\/kody\.example\/reset-password\?token=[0-9a-f]{64}$/,
	)
	expect(created.setupTokenExpiresAt).toBe(
		now.getTime() + adminPasswordSetupTokenExpiryMs,
	)
	expect(users.get(created.userId)).toMatchObject({
		email: 'person+launch@example.com',
		username: 'person-launch',
		email_verified_at: now.toISOString(),
		password_hash: 'admin_created_no_usable_password',
	})
	expect(passwordResets.get(created.userId)?.expires_at).toBe(
		now.getTime() + adminPasswordSetupTokenExpiryMs,
	)
	expect(userRoles.has(`${created.userId}:user`)).toBe(true)
})

test('adminCreateUserWithPasswordSetup rejects explicit reserved usernames and skips reserved generated ones', async () => {
	const explicit = createAdminUserCreationTestDb()
	await expect(
		adminCreateUserWithPasswordSetup({
			db: explicit.db,
			email: 'person@example.com',
			username: 'postmaster',
			setupLinkOrigin: 'https://kody.example/admin/invites',
		}),
	).rejects.toMatchObject({
		code: 'invalid_username',
		message: 'This username is reserved.',
	})
	expect(explicit.users.size).toBe(0)

	// A generated username derived from a reserved email local part must fall
	// through to a non-reserved suffixed candidate.
	const generated = createAdminUserCreationTestDb()
	const created = await adminCreateUserWithPasswordSetup({
		db: generated.db,
		email: 'support@example.com',
		username: null,
		setupLinkOrigin: 'https://kody.example/admin/invites',
	})
	expect(created.username).toBe('support-2')
})
