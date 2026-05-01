import { beforeAll, expect, test } from 'vitest'
import { RequestContext } from 'remix/fetch-router'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { createAuthHandler } from '#app/handlers/auth.ts'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'
const primaryUserEmail = 'me@kentcdodds.com'

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

					const insertUser = () => {
						const [username, email, passwordHash] = params as Array<string>
						const normalizedEmail = String(email).toLowerCase()
						if (users.has(normalizedEmail)) {
							throw new Error('UNIQUE constraint failed: users.email')
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
							normalizedQuery.includes('email')
						) {
							const user = readUserByEmail()
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

	async function addUser(email: string, password: string) {
		const passwordHash = await createPasswordHash(password)
		const user: TestUser = {
			id: nextId,
			email,
			username: email,
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

test('auth handler returns 400 for invalid JSON', async () => {
	const testDb = createTestDb()
	const handler = createAuthHandler({
		COOKIE_SECRET: testCookieSecret,
		APP_DB: testDb.db,
	})
	const authRequest = createAuthRequest('{', 'http://example.com/auth', handler)
	const response = await authRequest.run()
	expect(response.status).toBe(400)
	const payload = await response.json()
	expect(payload).toEqual({ error: 'Invalid JSON payload.' })
})

test('auth handler returns 400 for missing fields', async () => {
	const testDb = createTestDb()
	const handler = createAuthHandler({
		COOKIE_SECRET: testCookieSecret,
		APP_DB: testDb.db,
	})
	const authRequest = createAuthRequest(
		{ email: 'a@b.com' },
		'http://example.com/auth',
		handler,
	)
	const response = await authRequest.run()
	expect(response.status).toBe(400)
	const payload = await response.json()
	expect(payload).toEqual({
		error: 'Invalid request body.',
	})
})

test('auth handler rejects login with unknown user', async () => {
	const testDb = createTestDb()
	const handler = createAuthHandler({
		COOKIE_SECRET: testCookieSecret,
		APP_DB: testDb.db,
	})
	const authRequest = createAuthRequest(
		{ email: primaryUserEmail, password: 'secret', mode: 'login' },
		'http://example.com/auth',
		handler,
	)
	const response = await authRequest.run()
	expect(response.status).toBe(401)
	const payload = await response.json()
	expect(payload).toEqual({ error: 'Invalid email or password.' })
})

test('auth handler rejects signup for non-primary email', async () => {
	const testDb = createTestDb()
	const handler = createAuthHandler({
		COOKIE_SECRET: testCookieSecret,
		APP_DB: testDb.db,
	})
	const authRequest = createAuthRequest(
		{ email: 'new@b.com', password: 'secret', mode: 'signup' },
		'http://example.com/auth',
		handler,
	)
	const response = await authRequest.run()
	expect(response.status).toBe(403)
	const payload = await response.json()
	expect(payload).toEqual({
		error: `Only ${primaryUserEmail} can sign in or sign up.`,
	})
	expect(testDb.users.has('new@b.com')).toBe(false)
})

test('auth handler rejects login for non-primary email', async () => {
	const testDb = createTestDb()
	await testDb.addUser('a@b.com', 'secret')
	const handler = createAuthHandler({
		COOKIE_SECRET: testCookieSecret,
		APP_DB: testDb.db,
	})
	const authRequest = createAuthRequest(
		{ email: 'a@b.com', password: 'secret', mode: 'login' },
		'http://example.com/auth',
		handler,
	)
	const response = await authRequest.run()
	expect(response.status).toBe(403)
	const payload = await response.json()
	expect(payload).toEqual({
		error: `Only ${primaryUserEmail} can sign in or sign up.`,
	})
})

test('auth handler creates a user and cookie for signup', async () => {
	const testDb = createTestDb()
	const handler = createAuthHandler({
		COOKIE_SECRET: testCookieSecret,
		APP_DB: testDb.db,
	})
	const authRequest = createAuthRequest(
		{ email: primaryUserEmail, password: 'secret', mode: 'signup' },
		'http://example.com/auth',
		handler,
	)
	const response = await authRequest.run()
	expect(response.status).toBe(200)
	const payload = await response.json()
	expect(payload).toEqual({ ok: true, mode: 'signup' })
	expect(testDb.users.has(primaryUserEmail)).toBe(true)
	const setCookie = response.headers.get('Set-Cookie') ?? ''
	expect(setCookie).toContain('kody_session=')
	expect(setCookie).toContain('Max-Age=604800')
})

test('auth handler returns ok with a session cookie for login', async () => {
	const testDb = createTestDb()
	const handler = createAuthHandler({
		COOKIE_SECRET: testCookieSecret,
		APP_DB: testDb.db,
	})
	await testDb.addUser(primaryUserEmail, 'secret')
	const authRequest = createAuthRequest(
		{ email: primaryUserEmail, password: 'secret', mode: 'login' },
		'http://example.com/auth',
		handler,
	)
	const response = await authRequest.run()
	expect(response.status).toBe(200)
	const payload = await response.json()
	expect(payload).toEqual({ ok: true, mode: 'login' })
	const setCookie = response.headers.get('Set-Cookie') ?? ''
	expect(setCookie).toContain('kody_session=')
	expect(setCookie).toContain('Max-Age=604800')
})

test('auth handler sets a 30-day cookie when remember me is enabled', async () => {
	const testDb = createTestDb()
	const handler = createAuthHandler({
		COOKIE_SECRET: testCookieSecret,
		APP_DB: testDb.db,
	})
	await testDb.addUser(primaryUserEmail, 'secret')
	const authRequest = createAuthRequest(
		{
			email: primaryUserEmail,
			password: 'secret',
			mode: 'login',
			rememberMe: true,
		},
		'http://example.com/auth',
		handler,
	)
	const response = await authRequest.run()
	expect(response.status).toBe(200)
	const payload = await response.json()
	expect(payload).toEqual({ ok: true, mode: 'login' })
	const setCookie = response.headers.get('Set-Cookie') ?? ''
	expect(setCookie).toContain('kody_session=')
	expect(setCookie).toContain('Max-Age=2592000')
})

test('auth handler sets Secure cookie over https', async () => {
	const testDb = createTestDb()
	const handler = createAuthHandler({
		COOKIE_SECRET: testCookieSecret,
		APP_DB: testDb.db,
	})
	await testDb.addUser(primaryUserEmail, 'secret')
	const authRequest = createAuthRequest(
		{ email: primaryUserEmail, password: 'secret', mode: 'login' },
		'https://example.com/auth',
		handler,
	)
	const response = await authRequest.run()
	const setCookie = response.headers.get('Set-Cookie') ?? ''
	expect(setCookie).toContain('Secure')
})
