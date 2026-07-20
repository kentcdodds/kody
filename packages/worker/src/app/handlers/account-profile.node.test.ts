import { beforeAll, expect, test, vi } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { createAccountProfileApiHandler } from './account-profile.ts'
import { CommunityActionError } from '#worker/community/errors.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

const mockModule = vi.hoisted(() => ({
	updateCommunityProfile: vi.fn(),
}))

vi.mock('#worker/community/social-service.ts', () => ({
	updateCommunityProfile: (...args: Array<unknown>) =>
		mockModule.updateCommunityProfile(...args),
}))

type TestUser = {
	id: number
	email: string
	username: string
	password_hash: string
	display_name: string | null
	bio: string | null
	profile_visibility: 'public' | 'private'
	created_at: string
	updated_at: string
}

function createProfileTestDb(initialUsers: Array<TestUser>) {
	const users = new Map(initialUsers.map((user) => [user.id, { ...user }]))
	const db = {
		prepare(query: string) {
			const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(...params: Array<unknown>) {
					const readUserById = () => {
						const id = Number(params[0])
						return users.get(id) ?? null
					}
					const readUserByUsername = () => {
						const username = String(params[0] ?? '').toLowerCase()
						return (
							Array.from(users.values()).find(
								(user) => user.username.toLowerCase() === username,
							) ?? null
						)
					}
					const updateUsername = () => {
						const [username, updatedAt, id] = params as Array<string | number>
						const user = users.get(Number(id))
						if (!user) return null
						if (
							Array.from(users.values()).some(
								(existingUser) =>
									existingUser.id !== user.id &&
									existingUser.username.toLowerCase() ===
										String(username).toLowerCase(),
							)
						) {
							throw new Error('UNIQUE constraint failed: users.username')
						}
						user.username = String(username)
						user.updated_at = String(updatedAt)
						return user
					}
					const executeAll = async () => {
						if (normalizedQuery.includes('update "users"')) {
							const user = updateUsername()
							return {
								results: user ? [{ ...user }] : [],
								meta: { changes: user ? 1 : 0, last_row_id: 0 },
							}
						}
						if (
							normalizedQuery.startsWith('select') &&
							normalizedQuery.includes('from "users"') &&
							/"id"\s*=/.test(normalizedQuery)
						) {
							const user = readUserById()
							return {
								results: user ? [{ ...user }] : [],
								meta: { changes: 0, last_row_id: 0 },
							}
						}
						if (
							normalizedQuery.startsWith('select') &&
							normalizedQuery.includes('from "users"') &&
							/"username"\s*=/.test(normalizedQuery)
						) {
							const user = readUserByUsername()
							return {
								results: user ? [{ ...user }] : [],
								meta: { changes: 0, last_row_id: 0 },
							}
						}
						return {
							results: [],
							meta: { changes: 0, last_row_id: 0 },
						}
					}

					return {
						async all() {
							return executeAll()
						},
						async first() {
							const result = await executeAll()
							return result.results[0] ?? null
						},
						async run() {
							if (normalizedQuery.includes('update "users"')) {
								const user = updateUsername()
								return {
									meta: { changes: user ? 1 : 0, last_row_id: 0 },
								}
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

	return { db, users }
}

function createUser(
	id: number,
	username: string,
	email = `${username}@example.com`,
	profile?: Partial<
		Pick<TestUser, 'display_name' | 'bio' | 'profile_visibility'>
	>,
) {
	return {
		id,
		email,
		username,
		password_hash: 'unused',
		display_name: profile?.display_name ?? null,
		bio: profile?.bio ?? null,
		profile_visibility: profile?.profile_visibility ?? 'public',
		created_at: new Date(0).toISOString(),
		updated_at: new Date(0).toISOString(),
	} satisfies TestUser
}

async function createRequest(input: {
	session: AuthSession
	method?: string
	body?: Record<string, unknown>
}) {
	const cookie = await createAuthCookie(input.session, false)
	return new Request('http://example.com/account/profile.json', {
		method: input.method ?? 'GET',
		headers: {
			Cookie: cookie,
			...(input.body ? { 'Content-Type': 'application/json' } : {}),
		},
		body: input.body ? JSON.stringify(input.body) : undefined,
	})
}

function createEnv(db: D1Database) {
	return {
		APP_DB: db,
		COOKIE_SECRET: testCookieSecret,
	} as Env
}

async function runHandler(
	handler: ReturnType<typeof createAccountProfileApiHandler>,
	request: Request,
) {
	return handler.handler({
		request,
		url: new URL(request.url),
		params: {},
	} as never)
}

beforeAll(() => {
	setAuthSessionSecret(testCookieSecret)
})

test('account profile API returns email and username for the signed-in user', async () => {
	const testDb = createProfileTestDb([createUser(1, 'current-user')])
	const handler = createAccountProfileApiHandler(createEnv(testDb.db))

	const response = await runHandler(
		handler,
		await createRequest({
			session: {
				id: '1',
				email: 'current-user@example.com',
				rememberMe: false,
			},
		}),
	)

	expect(response.status).toBe(200)
	expect(await response.json()).toEqual({
		ok: true,
		email: 'current-user@example.com',
		emailVerified: false,
		username: 'current-user',
		displayName: 'current-user',
		bio: null,
		profileVisibility: 'public',
	})
	// Reads are not audited.
	expect(logAuditEventSpy).not.toHaveBeenCalled()
})

test('account profile API updates username for the signed-in user', async () => {
	const testDb = createProfileTestDb([createUser(1, 'current-user')])
	const handler = createAccountProfileApiHandler(createEnv(testDb.db))

	const response = await runHandler(
		handler,
		await createRequest({
			session: {
				id: '1',
				email: 'current-user@example.com',
				rememberMe: false,
			},
			method: 'POST',
			body: { username: 'Next_User' },
		}),
	)

	expect(response.status).toBe(200)
	expect(await response.json()).toMatchObject({
		ok: true,
		email: 'current-user@example.com',
		username: 'next_user',
		displayName: 'next_user',
		bio: null,
		profileVisibility: 'public',
	})
	expect(testDb.users.get(1)?.username).toBe('next_user')
	expect(mockModule.updateCommunityProfile).not.toHaveBeenCalled()
	expect(logAuditEventSpy).toHaveBeenCalledTimes(1)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'account',
			action: 'update_username',
			result: 'success',
		}),
	)
})

test('account profile API rejects invalid or duplicate usernames', async () => {
	const testDb = createProfileTestDb([
		createUser(1, 'current-user'),
		createUser(2, 'taken-user'),
	])
	const handler = createAccountProfileApiHandler(createEnv(testDb.db))
	const session = {
		id: '1',
		email: 'current-user@example.com',
		rememberMe: false,
	}

	const invalidResponse = await runHandler(
		handler,
		await createRequest({
			session,
			method: 'POST',
			body: { username: 'bad username' },
		}),
	)
	expect(invalidResponse.status).toBe(400)

	const reservedResponse = await runHandler(
		handler,
		await createRequest({
			session,
			method: 'POST',
			body: { username: 'kody' },
		}),
	)
	expect(reservedResponse.status).toBe(400)
	expect(await reservedResponse.json()).toEqual({
		ok: false,
		error: 'This username is reserved.',
	})

	const duplicateResponse = await runHandler(
		handler,
		await createRequest({
			session,
			method: 'POST',
			body: { username: 'Taken-User' },
		}),
	)
	expect(duplicateResponse.status).toBe(409)
	expect(await duplicateResponse.json()).toEqual({
		ok: false,
		error: 'Username already registered.',
	})
	expect(testDb.users.get(1)?.username).toBe('current-user')
	// Only the duplicate attempt is audited; validation rejections are not.
	expect(logAuditEventSpy).toHaveBeenCalledTimes(1)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'account',
			action: 'update_username',
			result: 'failure',
			reason: 'username_exists',
		}),
	)
})

test('account profile API rounds trip displayName, bio, and visibility', async () => {
	const testDb = createProfileTestDb([createUser(1, 'current-user')])
	const env = createEnv(testDb.db)
	const handler = createAccountProfileApiHandler(env)
	const session = {
		id: '1',
		email: 'current-user@example.com',
		rememberMe: false,
	}

	mockModule.updateCommunityProfile.mockImplementation(
		async (input: {
			displayName?: string
			bio?: string
			visibility?: 'public' | 'private'
		}) => {
			const user = testDb.users.get(1)
			if (!user) return
			if (input.displayName !== undefined) {
				user.display_name =
					input.displayName.trim().length === 0
						? null
						: input.displayName.trim()
			}
			if (input.bio !== undefined) {
				user.bio = input.bio.trim().length === 0 ? null : input.bio.trim()
			}
			if (input.visibility !== undefined) {
				user.profile_visibility = input.visibility
			}
		},
	)

	const response = await runHandler(
		handler,
		await createRequest({
			session,
			method: 'POST',
			body: {
				displayName: 'Current User',
				bio: 'I build packages',
				profileVisibility: 'private',
			},
		}),
	)

	expect(response.status).toBe(200)
	expect(await response.json()).toEqual({
		ok: true,
		email: 'current-user@example.com',
		emailVerified: false,
		username: 'current-user',
		displayName: 'Current User',
		bio: 'I build packages',
		profileVisibility: 'private',
	})
	expect(mockModule.updateCommunityProfile).toHaveBeenCalledWith({
		env,
		numericUserId: 1,
		displayName: 'Current User',
		bio: 'I build packages',
		visibility: 'private',
	})
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'account',
			action: 'update_profile',
			result: 'success',
		}),
	)

	const getResponse = await runHandler(
		handler,
		await createRequest({ session }),
	)
	expect(await getResponse.json()).toMatchObject({
		displayName: 'Current User',
		bio: 'I build packages',
		profileVisibility: 'private',
	})
})

test('account profile API validates profile field updates', async () => {
	const testDb = createProfileTestDb([createUser(1, 'current-user')])
	const handler = createAccountProfileApiHandler(createEnv(testDb.db))
	const session = {
		id: '1',
		email: 'current-user@example.com',
		rememberMe: false,
	}

	const invalidVisibility = await runHandler(
		handler,
		await createRequest({
			session,
			method: 'POST',
			body: { profileVisibility: 'friends' },
		}),
	)
	expect(invalidVisibility.status).toBe(400)
	expect(await invalidVisibility.json()).toEqual({
		ok: false,
		error: 'Profile visibility is invalid.',
	})

	mockModule.updateCommunityProfile.mockRejectedValue(
		new CommunityActionError('Display name must be at most 50 characters.'),
	)
	const invalidDisplayName = await runHandler(
		handler,
		await createRequest({
			session,
			method: 'POST',
			body: { displayName: 'x'.repeat(51) },
		}),
	)
	expect(invalidDisplayName.status).toBe(400)
	expect(await invalidDisplayName.json()).toEqual({
		ok: false,
		error: 'Display name must be at most 50 characters.',
	})
})
