import { expect, test } from 'vitest'
import { resolveSocialAuthUser } from '#app/resolve-social-auth.ts'
import { mockGitHubProfile } from '#app/social-auth-mock.ts'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'

type TestUser = {
	id: number
	email: string
	username: string
	password_hash: string
	email_verified_at: string | null
	stable_user_id: string
}

type TestConnection = {
	id: number
	user_id: number
	provider_name: string
	provider_id: string
	created_at: string
	updated_at: string
}

function createResolveSocialAuthTestEnv() {
	let nextUserId = 1
	let nextConnectionId = 1
	const users = new Map<string, TestUser>()
	const usersById = new Map<number, TestUser>()
	const connections = new Map<string, TestConnection>()

	const db = {
		prepare(query: string) {
			const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(...params: Array<unknown>) {
					const executeAll = async () => {
						if (
							normalizedQuery.startsWith('select') &&
							normalizedQuery.includes('from "auth_connections"') &&
							/"provider_name"\s*=/.test(normalizedQuery)
						) {
							const providerName = String(params[0] ?? '')
							const providerId = String(params[1] ?? '')
							const connection =
								connections.get(`${providerName}:${providerId}`) ?? null
							return {
								results: connection ? [{ ...connection }] : [],
								meta: { changes: 0, last_row_id: 0 },
							}
						}
						if (
							normalizedQuery.startsWith('select') &&
							normalizedQuery.includes('from "auth_connections"') &&
							/"id"\s*=/.test(normalizedQuery)
						) {
							const id = Number(params[0])
							const connection =
								Array.from(connections.values()).find((row) => row.id === id) ??
								null
							return {
								results: connection ? [{ ...connection }] : [],
								meta: { changes: 0, last_row_id: 0 },
							}
						}
						if (
							normalizedQuery.startsWith('select') &&
							normalizedQuery.includes('from "users"') &&
							/"email"\s*=/.test(normalizedQuery)
						) {
							const email = String(params[0] ?? '').toLowerCase()
							const user = users.get(email)
							return {
								results: user ? [{ ...user }] : [],
								meta: { changes: 0, last_row_id: 0 },
							}
						}
						if (
							normalizedQuery.startsWith('select') &&
							normalizedQuery.includes('from "users"') &&
							/"id"\s*=/.test(normalizedQuery)
						) {
							const id = Number(params[0])
							const user = usersById.get(id)
							return {
								results: user ? [{ ...user }] : [],
								meta: { changes: 0, last_row_id: 0 },
							}
						}
						if (normalizedQuery.includes('insert into "auth_connections"')) {
							const now = new Date().toISOString()
							const connection: TestConnection = {
								id: nextConnectionId++,
								user_id: Number(params[0]),
								provider_name: String(params[1]),
								provider_id: String(params[2]),
								created_at: now,
								updated_at: now,
							}
							connections.set(
								`${connection.provider_name}:${connection.provider_id}`,
								connection,
							)
							return {
								results: [{ ...connection }],
								meta: { changes: 1, last_row_id: connection.id },
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
							if (normalizedQuery.includes('insert into "auth_connections"')) {
								const now = new Date().toISOString()
								const connection: TestConnection = {
									id: nextConnectionId++,
									user_id: Number(params[0]),
									provider_name: String(params[1]),
									provider_id: String(params[2]),
									created_at: now,
									updated_at: now,
								}
								connections.set(
									`${connection.provider_name}:${connection.provider_id}`,
									connection,
								)
								return {
									meta: { changes: 1, last_row_id: connection.id },
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

	return {
		env: {
			COOKIE_SECRET: 'test-cookie-secret-0123456789abcdef0123456789',
			SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
			APP_DB: db,
			SENTRY_ENVIRONMENT: 'test',
		} as Env,
		users,
		usersById,
		connections,
	}
}

test('resolveSocialAuthUser returns an existing linked provider account', async () => {
	const { env, users, usersById, connections } =
		createResolveSocialAuthTestEnv()
	const passwordHash = await createPasswordHash('password123')
	const user: TestUser = {
		id: 7,
		email: mockGitHubProfile.email!.toLowerCase(),
		username: 'linked-user',
		password_hash: passwordHash,
		email_verified_at: new Date().toISOString(),
		stable_user_id: 'stable-linked-user',
	}
	users.set(user.email, user)
	usersById.set(user.id, user)
	connections.set(`github:${mockGitHubProfile.id}`, {
		id: 1,
		user_id: user.id,
		provider_name: 'github',
		provider_id: String(mockGitHubProfile.id),
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
	})

	const resolved = await resolveSocialAuthUser({
		env,
		result: {
			provider: 'github',
			account: {
				provider: 'github',
				providerAccountId: String(mockGitHubProfile.id),
			},
			profile: mockGitHubProfile,
			tokens: {
				accessToken: 'token',
			},
		},
	})

	expect(resolved).toEqual({
		userId: 7,
		email: user.email,
		isNewUser: false,
		provider: 'github',
		providerId: String(mockGitHubProfile.id),
	})
})

test('resolveSocialAuthUser links a provider to an existing email match', async () => {
	const { env, users, usersById, connections } =
		createResolveSocialAuthTestEnv()
	const passwordHash = await createPasswordHash('password123')
	const user: TestUser = {
		id: 9,
		email: mockGitHubProfile.email!.toLowerCase(),
		username: 'email-match',
		password_hash: passwordHash,
		email_verified_at: new Date().toISOString(),
		stable_user_id: 'stable-email-match',
	}
	users.set(user.email, user)
	usersById.set(user.id, user)

	const resolved = await resolveSocialAuthUser({
		env,
		result: {
			provider: 'github',
			account: {
				provider: 'github',
				providerAccountId: String(mockGitHubProfile.id),
			},
			profile: mockGitHubProfile,
			tokens: {
				accessToken: 'token',
			},
		},
	})

	expect(resolved.userId).toBe(9)
	expect(resolved.isNewUser).toBe(false)
	expect(connections.get(`github:${mockGitHubProfile.id}`)?.user_id).toBe(9)
})
