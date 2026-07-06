import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { RequestContext } from 'remix/router'
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

function createAuthTestContext(
	options: {
		signupEnabled?: boolean
		failRoleAssignment?: boolean
		emailConfigured?: boolean
	} = {},
) {
	const testDb = createTestDb({
		failRoleAssignment: options.failRoleAssignment ?? false,
	})
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
		...(options.emailConfigured
			? {
					CLOUDFLARE_ACCOUNT_ID: 'cf-account-test',
					CLOUDFLARE_API_TOKEN: 'cf-token-test',
					CLOUDFLARE_API_BASE_URL: 'https://cloudflare-api.example.com',
				}
			: {}),
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

type TestInvite = {
	code: string
	max_uses: number
	use_count: number
	expires_at: string | null
	revoked_at: string | null
}

function createTestDb(options: { failRoleAssignment?: boolean } = {}) {
	let nextId = 1
	const users = new Map<string, TestUser>()
	const invites = new Map<string, TestInvite>()
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
					const readInvite = () => {
						const code = String(params[0] ?? '').toUpperCase()
						const invite = invites.get(code)
						return invite
							? {
									...invite,
									created_by: 1,
									note: '',
									created_at: '2026-07-05T00:00:00.000Z',
								}
							: null
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
						if (normalizedQuery.includes('insert into "email_verifications"')) {
							return {
								results: [],
								meta: { changes: 1, last_row_id: 1 },
							}
						}
						if (
							normalizedQuery.startsWith('select') &&
							normalizedQuery.includes('from invites') &&
							normalizedQuery.includes('where code =')
						) {
							const invite = readInvite()
							return {
								results: invite ? [invite] : [],
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
							if (normalizedQuery.includes('insert into "users"')) {
								const user = insertUser()
								return { meta: { changes: 1, last_row_id: user.id } }
							}
							if (
								normalizedQuery.includes('delete from "email_verifications"') ||
								normalizedQuery.includes('insert into "email_verifications"')
							) {
								return { meta: { changes: 1, last_row_id: 1 } }
							}
							if (
								normalizedQuery.startsWith('update invites') &&
								normalizedQuery.includes('set use_count = use_count + 1')
							) {
								const code = String(params[0] ?? '').toUpperCase()
								const nowIso = String(params[1] ?? '')
								const invite = invites.get(code)
								if (
									invite &&
									!invite.revoked_at &&
									(!invite.expires_at || invite.expires_at > nowIso) &&
									invite.use_count < invite.max_uses
								) {
									invite.use_count += 1
									return { meta: { changes: 1, last_row_id: 0 } }
								}
								return { meta: { changes: 0, last_row_id: 0 } }
							}
							if (
								normalizedQuery.startsWith('update invites') &&
								normalizedQuery.includes('set use_count = use_count - 1')
							) {
								const code = String(params[0] ?? '').toUpperCase()
								const invite = invites.get(code)
								if (invite && invite.use_count > 0) {
									invite.use_count -= 1
									return { meta: { changes: 1, last_row_id: 0 } }
								}
								return { meta: { changes: 0, last_row_id: 0 } }
							}
							if (
								normalizedQuery.includes('insert or ignore into user_roles')
							) {
								// changes: 0 simulates a missing seeded role (partial
								// migration), which must fail the signup.
								return {
									meta: {
										changes: options.failRoleAssignment ? 0 : 1,
										last_row_id: 0,
									},
								}
							}
							if (normalizedQuery.includes('delete from users')) {
								const userId = Number(params[0])
								for (const [email, user] of users) {
									if (user.id === userId) {
										users.delete(email)
										return { meta: { changes: 1, last_row_id: 0 } }
									}
								}
								return { meta: { changes: 0, last_row_id: 0 } }
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

	function addInvite(code: string) {
		invites.set(code.toUpperCase(), {
			code: code.toUpperCase(),
			max_uses: 1,
			use_count: 0,
			expires_at: '2099-01-01T00:00:00.000Z',
			revoked_at: null,
		})
	}

	return { db, users, invites, addUser, addInvite }
}

beforeAll(() => {
	setAuthSessionSecret(testCookieSecret)
})

afterEach(() => {
	vi.unstubAllGlobals()
})

function stubCloudflareEmailFetch(
	result: { ok: true } | { ok: false; message: string },
) {
	const fetchStub = vi.fn(async () =>
		result.ok
			? Response.json({ success: true, result: { message_id: 'msg-1' } })
			: Response.json(
					{ success: false, errors: [{ message: result.message }] },
					{ status: 500 },
				),
	)
	vi.stubGlobal('fetch', fetchStub)
	return fetchStub
}

test('auth handler login and signup workflow', async () => {
	// Production signups must actually deliver the verification email, so
	// the production context gets a (stubbed) configured Cloudflare sender.
	const productionContext = createAuthTestContext({ emailConfigured: true })
	const signupContext = createAuthTestContext({ signupEnabled: true })
	stubCloudflareEmailFetch({ ok: true })

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
		password: 'password123',
		mode: 'signup',
	})
	expect(blockedSignupResponse.status).toBe(400)
	expect(await blockedSignupResponse.json()).toEqual({
		error: 'Invite code is required.',
	})
	expect(productionContext.testDb.users.has('new@example.com')).toBe(false)

	productionContext.testDb.addInvite('PROD-INVITE')
	const invitedSignupResponse = await productionContext.request({
		email: 'invited@example.com',
		username: 'invited-user',
		password: 'password123',
		mode: 'signup',
		inviteCode: 'prod-invite',
	})
	expect(invitedSignupResponse.status).toBe(200)
	expect(await invitedSignupResponse.json()).toEqual({
		ok: true,
		mode: 'signup',
		emailVerificationRequired: true,
		message: 'Check your email to verify your account.',
	})
	expect(productionContext.testDb.users.has('invited@example.com')).toBe(true)
	expect(productionContext.testDb.invites.get('PROD-INVITE')?.use_count).toBe(1)

	const weakPasswordSignupResponse = await signupContext.request({
		email: 'weak@example.com',
		username: 'weak-user',
		password: 'short',
		mode: 'signup',
	})
	expect(weakPasswordSignupResponse.status).toBe(400)
	expect(await weakPasswordSignupResponse.json()).toEqual({
		error: 'Password must be at least 8 characters.',
	})
	expect(signupContext.testDb.users.has('weak@example.com')).toBe(false)

	const allowedSignupResponse = await signupContext.request({
		email: 'allowed@example.com',
		username: 'allowed-user',
		password: 'password123',
		mode: 'signup',
	})
	expect(allowedSignupResponse.status).toBe(200)
	expect(await allowedSignupResponse.json()).toEqual({
		ok: true,
		mode: 'signup',
		emailVerificationRequired: true,
		message: 'Check your email to verify your account.',
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
		password: 'password123',
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

test('signup fails when the default user role cannot be assigned', async () => {
	const context = createAuthTestContext({
		signupEnabled: true,
		failRoleAssignment: true,
	})

	const response = await context.request({
		email: 'roleless@example.com',
		username: 'roleless-user',
		password: 'password123',
		mode: 'signup',
	})
	expect(response.status).toBe(500)
	expect(await response.json()).toEqual({ error: 'Unable to create account.' })
	expect(response.headers.get('Set-Cookie')).toBeNull()
	// The created user row is rolled back so signup can be retried.
	expect(context.testDb.users.has('roleless@example.com')).toBe(false)
})

test('signup rolls back when the verification email cannot be sent', async () => {
	const context = createAuthTestContext({
		signupEnabled: true,
		emailConfigured: true,
	})
	stubCloudflareEmailFetch({ ok: false, message: 'delivery refused' })

	const response = await context.request({
		email: 'undeliverable@example.com',
		username: 'undeliverable-user',
		password: 'password123',
		mode: 'signup',
	})
	expect(response.status).toBe(500)
	expect(await response.json()).toEqual({
		error:
			'Unable to send the verification email. Please try signing up again.',
	})
	expect(response.headers.get('Set-Cookie')).toBeNull()
	// The created user row is rolled back so signup can be retried.
	expect(context.testDb.users.has('undeliverable@example.com')).toBe(false)
})

test('production signup fails closed when no verification email sender is configured', async () => {
	const context = createAuthTestContext()
	context.testDb.addInvite('PROD-NO-EMAIL')

	const response = await context.request({
		email: 'no-sender@example.com',
		username: 'no-sender-user',
		password: 'password123',
		mode: 'signup',
		inviteCode: 'prod-no-email',
	})
	expect(response.status).toBe(500)
	expect(await response.json()).toEqual({
		error:
			'Unable to send the verification email. Please try signing up again.',
	})
	expect(context.testDb.users.has('no-sender@example.com')).toBe(false)
	// The consumed invite use is released so the invite can be retried.
	expect(context.testDb.invites.get('PROD-NO-EMAIL')?.use_count).toBe(0)
})
