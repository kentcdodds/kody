import { beforeAll, expect, test } from 'vitest'
import { RequestContext } from 'remix/fetch-router'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { createAuthHandler } from '#app/handlers/auth.ts'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

function createAuthRequest(
	body: unknown,
	url: string,
	handler: ReturnType<typeof createAuthHandler>,
) {
	const request = new Request(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: typeof body === 'string' ? body : JSON.stringify(body),
	})
	const context = new RequestContext(request)

	return {
		run: () => handler.handler(context),
	}
}

function createAuthTestContext(options: { signupEnabled?: boolean } = {}) {
	const testDb = createTestDb()
	const handler = createAuthHandler({
		COOKIE_SECRET: testCookieSecret,
		APP_DB: testDb.db,
		// SENTRY_ENVIRONMENT defaults to 'production' (signups blocked).
		// Pass `signupEnabled: true` to put the handler in the 'test' env
		// that mirrors the wrangler `test`/`preview` envs.
		...(options.signupEnabled
			? {
					SENTRY_ENVIRONMENT: 'test' as const,
				}
			: {
					SENTRY_ENVIRONMENT: 'production' as const,
				}),
	} as unknown as Parameters<typeof createAuthHandler>[0])

	return {
		testDb,
		request(body: unknown, url = 'http://example.com/auth') {
			return createAuthRequest(body, url, handler).run()
		},
	}
}

type TestUser = {
	id: number
	email: string
	username: string
	password_hash: string
}

function createTestDb() {
	let nextId = 1
	const users = new Map<string, TestUser>()
	const db = {
		prepare(query: string) {
			const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(...params: Array<unknown>) {
					const readUserByEmail = () => {
						const email = String(params[0] ?? '').toLowerCase()
						return users.get(email) ?? null
					}
					const readUserByUsername = () => {
						const username = String(params[0] ?? '').toLowerCase()
						return (
							Array.from(users.values()).find(
								(user) => user.username.toLowerCase() === username,
							) ?? null
						)
					}

					const insertUser = () => {
						const [username, email, passwordHash] = params as Array<string>
						const normalizedEmail = String(email).toLowerCase()
						if (users.has(normalizedEmail)) {
							throw new Error('UNIQUE constraint failed: users.email')
						}
						if (
							Array.from(users.values()).some(
								(user) =>
									user.username.toLowerCase() ===
									String(username).toLowerCase(),
							)
						) {
							throw new Error('UNIQUE constraint failed: users.username')
						}
						const user: TestUser = {
							id: nextId,
							email: String(email),
							username: String(username),
							password_hash: String(passwordHash),
						}
						nextId += 1
						users.set(normalizedEmail, user)
						return user
					}

					const executeAll = async () => {
						if (
							normalizedQuery.startsWith('select') &&
							normalizedQuery.includes('from "users"') &&
							/"email"\s*=/.test(normalizedQuery)
						) {
							const user = readUserByEmail()
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

						if (normalizedQuery.includes('insert into "users"')) {
							const user = insertUser()
							return {
								results: [{ ...user }],
								meta: { changes: 1, last_row_id: user.id },
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
							if (normalizedQuery.includes('insert into "users"')) {
								const user = insertUser()
								return { meta: { changes: 1, last_row_id: user.id } }
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

	async function addUser(email: string, password: string, username = email) {
		const passwordHash = await createPasswordHash(password)
		const user: TestUser = {
			id: nextId,
			email,
			username,
			password_hash: passwordHash,
		}
		nextId += 1
		users.set(email.toLowerCase(), user)
		return user
	}

	return { db, users, addUser }
}

beforeAll(() => {
	setAuthSessionSecret(testCookieSecret)
})

test('auth handler login and signup workflow', async () => {
	const productionContext = createAuthTestContext()
	const signupContext = createAuthTestContext({ signupEnabled: true })

	const invalidJsonResponse = await productionContext.request('{')
	expect(invalidJsonResponse.status).toBe(400)
	expect(await invalidJsonResponse.json()).toEqual({
		error: 'Invalid JSON payload.',
	})

	const missingFieldsResponse = await productionContext.request({
		email: 'a@b.com',
	})
	expect(missingFieldsResponse.status).toBe(400)
	expect(await missingFieldsResponse.json()).toEqual({
		error: 'Invalid request body.',
	})

	const unknownUserLoginResponse = await productionContext.request({
		email: 'someone@example.com',
		password: 'secret',
		mode: 'login',
	})
	expect(unknownUserLoginResponse.status).toBe(401)
	expect(await unknownUserLoginResponse.json()).toEqual({
		error: 'Invalid email or password.',
	})

	const blockedSignupResponse = await productionContext.request({
		email: 'new@example.com',
		username: 'new-user',
		password: 'secret',
		mode: 'signup',
	})
	expect(blockedSignupResponse.status).toBe(403)
	expect(await blockedSignupResponse.json()).toEqual({
		error: 'Signups are disabled.',
	})
	expect(productionContext.testDb.users.has('new@example.com')).toBe(false)

	const allowedSignupResponse = await signupContext.request({
		email: 'allowed@example.com',
		username: 'allowed-user',
		password: 'secret',
		mode: 'signup',
	})
	expect(allowedSignupResponse.status).toBe(200)
	expect(await allowedSignupResponse.json()).toEqual({
		ok: true,
		mode: 'signup',
	})
	expect(signupContext.testDb.users.has('allowed@example.com')).toBe(true)
	expect(signupContext.testDb.users.get('allowed@example.com')?.username).toBe(
		'allowed-user',
	)

	await signupContext.testDb.addUser(
		'existing@example.com',
		'secret',
		'existing-user',
	)

	const missingUsernameResponse = await signupContext.request({
		email: 'missing@example.com',
		password: 'secret',
		mode: 'signup',
	})
	expect(missingUsernameResponse.status).toBe(400)
	expect(await missingUsernameResponse.json()).toEqual({
		error: 'Username is required.',
	})

	const invalidUsernameResponse = await signupContext.request({
		email: 'invalid@example.com',
		username: 'no spaces',
		password: 'secret',
		mode: 'signup',
	})
	expect(invalidUsernameResponse.status).toBe(400)
	expect(await invalidUsernameResponse.json()).toEqual({
		error:
			'Username must be 3 to 32 characters, use only letters, numbers, hyphens, or underscores, and start and end with a letter or number.',
	})

	const duplicateUsernameResponse = await signupContext.request({
		email: 'duplicate@example.com',
		username: 'Existing-User',
		password: 'secret',
		mode: 'signup',
	})
	expect(duplicateUsernameResponse.status).toBe(409)
	expect(await duplicateUsernameResponse.json()).toEqual({
		error: 'Username already registered.',
	})

	const email = 'session-user@example.com'
	await productionContext.testDb.addUser(email, 'secret')

	const loginResponse = await productionContext.request({
		email,
		password: 'secret',
		mode: 'login',
	})
	expect(loginResponse.status).toBe(200)
	expect(await loginResponse.json()).toEqual({ ok: true, mode: 'login' })
	const loginCookie = loginResponse.headers.get('Set-Cookie') ?? ''
	expect(loginCookie).toContain('kody_session=')
	expect(loginCookie).toContain('Max-Age=604800')

	const rememberMeResponse = await productionContext.request({
		email,
		password: 'secret',
		mode: 'login',
		rememberMe: true,
	})
	expect(rememberMeResponse.status).toBe(200)
	expect(await rememberMeResponse.json()).toEqual({ ok: true, mode: 'login' })
	const rememberMeCookie = rememberMeResponse.headers.get('Set-Cookie') ?? ''
	expect(rememberMeCookie).toContain('kody_session=')
	expect(rememberMeCookie).toContain('Max-Age=2592000')

	const secureCookieResponse = await productionContext.request(
		{ email, password: 'secret', mode: 'login' },
		'https://example.com/auth',
	)
	expect(secureCookieResponse.headers.get('Set-Cookie') ?? '').toContain(
		'Secure',
	)
})
