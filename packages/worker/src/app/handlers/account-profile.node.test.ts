import { beforeAll, beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	updatePackagesForUsernameChange: vi.fn(),
	republishCommunityListingsAfterUsernameChange: vi.fn(),
}))

vi.mock('#worker/package-registry/username-change-packages.ts', () => ({
	updatePackagesForUsernameChange: (...args: Array<unknown>) =>
		mocks.updatePackagesForUsernameChange(...args),
	republishCommunityListingsAfterUsernameChange: (...args: Array<unknown>) =>
		mocks.republishCommunityListingsAfterUsernameChange(...args),
}))

import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { createAccountProfileApiHandler } from './account-profile.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

type TestUser = {
	id: number
	email: string
	username: string
	password_hash: string
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
) {
	return {
		id,
		email,
		username,
		password_hash: 'unused',
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
		APP_BASE_URL: 'http://example.com',
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

beforeEach(() => {
	mocks.updatePackagesForUsernameChange.mockReset()
	mocks.republishCommunityListingsAfterUsernameChange.mockReset()
	mocks.updatePackagesForUsernameChange.mockResolvedValue({
		updatedPackages: [],
		skippedPackages: [],
	})
	mocks.republishCommunityListingsAfterUsernameChange.mockResolvedValue({
		republishedPackageIds: [],
		warnings: [],
	})
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
	})
	// Reads are not audited.
	expect(logAuditEventSpy).not.toHaveBeenCalled()
	expect(mocks.updatePackagesForUsernameChange).not.toHaveBeenCalled()
})

test('account profile API updates username for the signed-in user', async () => {
	const testDb = createProfileTestDb([createUser(1, 'current-user')])
	const handler = createAccountProfileApiHandler(createEnv(testDb.db))
	mocks.updatePackagesForUsernameChange.mockResolvedValueOnce({
		updatedPackages: [
			{
				packageId: 'pkg-1',
				kodyId: 'demo',
				previousName: '@current-user/demo',
				nextName: '@next_user/demo',
				publishedCommit: 'abc',
				changedPaths: ['package.json'],
				shouldRepublishCommunityListing: true,
			},
		],
		skippedPackages: [],
	})
	mocks.republishCommunityListingsAfterUsernameChange.mockResolvedValueOnce({
		republishedPackageIds: ['pkg-1'],
		warnings: [],
	})

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
		packagesUpdated: 1,
		communityListingsRepublished: 1,
		packageUpdateMessage: 'Updated 1 package to the new @next_user scope.',
	})
	expect(testDb.users.get(1)?.username).toBe('next_user')
	expect(mocks.updatePackagesForUsernameChange).toHaveBeenCalledWith(
		expect.objectContaining({
			previousUsername: 'current-user',
			nextUsername: 'next_user',
		}),
	)
	expect(
		mocks.republishCommunityListingsAfterUsernameChange,
	).toHaveBeenCalledWith(
		expect.objectContaining({
			packageIds: ['pkg-1'],
		}),
	)
	expect(logAuditEventSpy).toHaveBeenCalledTimes(1)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'account',
			action: 'update_username',
			result: 'success',
		}),
	)
})

test('account profile API rejects username changes when package updates fail', async () => {
	const testDb = createProfileTestDb([createUser(1, 'current-user')])
	const handler = createAccountProfileApiHandler(createEnv(testDb.db))
	mocks.updatePackagesForUsernameChange.mockRejectedValueOnce(
		new Error('sync failed'),
	)

	const response = await runHandler(
		handler,
		await createRequest({
			session: {
				id: '1',
				email: 'current-user@example.com',
				rememberMe: false,
			},
			method: 'POST',
			body: { username: 'next_user' },
		}),
	)

	expect(response.status).toBe(500)
	expect(await response.json()).toEqual({
		ok: false,
		error:
			'Username was not changed because package updates failed: sync failed',
	})
	expect(testDb.users.get(1)?.username).toBe('current-user')
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'account',
			action: 'update_username',
			result: 'failure',
			reason: 'package_scope_update_failed',
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
	expect(mocks.updatePackagesForUsernameChange).not.toHaveBeenCalled()
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
