import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { RequestContext } from 'remix/router'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { createAuthHandler } from '#app/handlers/auth.ts'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import {
	consoleError,
	consoleInfo,
	consoleWarn,
} from '#worker/test-support/console-spies.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'

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
		signupMode?: 'invite' | 'open' | 'waitlist'
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
		SIGNUP_MODE: options.signupMode ?? 'invite',
		SENTRY_ENVIRONMENT:
			options.signupMode === 'open'
				? ('test' as const)
				: ('production' as const),
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
	plan: string
	stable_user_id: string
}

type TestInvite = {
	code: string
	max_uses: number
	use_count: number
	expires_at: string | null
	revoked_at: string | null
	plan: string | null
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
						const columnMatch = normalizedQuery.match(
							/insert into "users" \(([^)]+)\)/,
						)
						const columns = columnMatch
							? columnMatch[1]
									.split(',')
									.map((column) => column.trim().replaceAll('"', ''))
							: []
						const values = Object.fromEntries(
							columns.map((column, index) => [column, params[index]]),
						)
						const username = String(values.username ?? '')
						const email = String(values.email ?? '')
						const passwordHash = String(values.password_hash ?? '')
						const stableUserId = String(values.stable_user_id ?? '')
						const plan =
							values.plan === undefined || values.plan === null
								? null
								: String(values.plan)
						const normalizedEmail = email.toLowerCase()
						if (users.has(normalizedEmail)) {
							throw new Error('UNIQUE constraint failed: users.email')
						}
						if (
							Array.from(users.values()).some(
								(user) =>
									user.username.toLowerCase() === username.toLowerCase(),
							)
						) {
							throw new Error('UNIQUE constraint failed: users.username')
						}
						const user: TestUser = {
							id: nextId,
							email,
							username,
							password_hash: passwordHash,
							plan,
							stable_user_id: stableUserId,
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
			plan: 'free',
			stable_user_id: await createStableUserIdFromEmail(email),
		}
		nextId += 1
		users.set(email.toLowerCase(), user)
		return user
	}

	function addInvite(code: string, plan: string | null = 'free') {
		invites.set(code.toUpperCase(), {
			code: code.toUpperCase(),
			max_uses: 1,
			use_count: 0,
			expires_at: '2099-01-01T00:00:00.000Z',
			revoked_at: null,
			plan,
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
	const signupContext = createAuthTestContext({ signupMode: 'open' })
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
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'login',
			result: 'failure',
			reason: 'invalid_credentials',
		}),
	)

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
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'signup',
			result: 'success',
			email: 'invited@example.com',
		}),
	)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'invite_use',
			result: 'success',
		}),
	)

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
	expect(signupContext.testDb.users.get('allowed@example.com')?.plan).toBe(
		'free',
	)
	expect(signupContext.testDb.users.get('allowed@example.com')?.username).toBe(
		'allowed-user',
	)
	// The signup context has no email sender configured, so the skipped
	// verification send logs at info level in the non-production runtime.
	expect(consoleInfo).toHaveBeenCalledWith(
		'email-verification-send-skipped',
		expect.any(Number),
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

	// Reserved usernames double as reserved email local parts
	// ({username}@<platform domain>), so signup must deny them.
	for (const reserved of ['kody', 'postmaster', 'kody-r-0123456789abcdef']) {
		const reservedUsernameResponse = await signupContext.request({
			email: `${crypto.randomUUID().slice(0, 8)}@example.com`,
			username: reserved,
			password: 'password123',
			mode: 'signup',
		})
		expect(reservedUsernameResponse.status).toBe(400)
		expect(await reservedUsernameResponse.json()).toEqual({
			error: 'This username is reserved.',
		})
	}

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
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'login',
			result: 'success',
			email,
		}),
	)

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
	// The full workflow audits exactly these events, in order: the unknown
	// login, the invite-less production signup, the invited signup (+ invite
	// use), the weak-password rejection, the open signup, the six username
	// rejections, and the three successful logins.
	expect(auditEventSummaries()).toEqual([
		'login:failure',
		'signup:failure',
		'signup:success',
		'invite_use:success',
		'signup:failure',
		'signup:success',
		'signup:failure',
		'signup:failure',
		'signup:failure',
		'signup:failure',
		'signup:failure',
		'signup:failure',
		'login:success',
		'login:success',
		'login:success',
	])
})

test('signup fails when the default user role cannot be assigned', async () => {
	const context = createAuthTestContext({
		signupMode: 'open',
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
	expect(auditEventSummaries()).toEqual(['signup:failure'])
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'signup',
			result: 'failure',
		}),
	)
})

test('signup rolls back when the verification email cannot be sent', async () => {
	consoleError.mockImplementation(() => {})
	consoleWarn.mockImplementation(() => {})
	const context = createAuthTestContext({
		signupMode: 'open',
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
	// Only the verification failure is logged; the rollback delete succeeds.
	expect(consoleError).toHaveBeenCalledTimes(1)
	expect(consoleError).toHaveBeenCalledWith(
		expect.any(String),
		expect.any(Error),
	)
	// The failed Cloudflare API send is warned for operators.
	expect(consoleWarn).toHaveBeenCalledWith(
		'cloudflare-email-api-failed',
		expect.any(String),
	)
})

test('production signup fails closed when no verification email sender is configured', async () => {
	consoleError.mockImplementation(() => {})
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
	expect(consoleError).toHaveBeenCalledWith(
		expect.any(String),
		expect.any(Error),
	)
	// The skipped send is logged with the unconfigured-sender tag.
	expect(consoleInfo).toHaveBeenCalledWith(
		'cloudflare-email-unconfigured',
		expect.any(String),
	)
})

test('signup consuming a plan invite sets users.plan', async () => {
	const context = createAuthTestContext({ emailConfigured: true })
	stubCloudflareEmailFetch({ ok: true })
	context.testDb.addInvite('PLAN-PRO', 'pro')

	const response = await context.request({
		email: 'planned@example.com',
		username: 'planned-user',
		password: 'password123',
		mode: 'signup',
		inviteCode: 'plan-pro',
	})
	expect(response.status).toBe(200)
	expect(context.testDb.users.get('planned@example.com')?.plan).toBe('pro')
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'invite_use',
			result: 'success',
			reason: expect.stringContaining('plan=pro'),
		}),
	)
})

test('signup consuming a max invite writes users.plan max', async () => {
	const context = createAuthTestContext({ emailConfigured: true })
	stubCloudflareEmailFetch({ ok: true })
	context.testDb.addInvite('MAX-INVITE', 'max')

	const response = await context.request({
		email: 'max-invite@example.com',
		username: 'max-invite-user',
		password: 'password123',
		mode: 'signup',
		inviteCode: 'max-invite',
	})
	expect(response.status).toBe(200)
	expect(context.testDb.users.get('max-invite@example.com')?.plan).toBe('max')
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'invite_use',
			result: 'success',
			reason: expect.stringContaining('plan=max'),
		}),
	)
	expect(consoleWarn).not.toHaveBeenCalled()
})

test('signup stops when an invite has an invalid stored plan', async () => {
	const context = createAuthTestContext({ emailConfigured: true })
	stubCloudflareEmailFetch({ ok: true })
	context.testDb.addInvite('PLAN-UNKNOWN', 'enterprise-2099')

	await expect(
		context.request({
			email: 'unknown-plan-invite@example.com',
			username: 'unknown-plan-invite-user',
			password: 'password123',
			mode: 'signup',
			inviteCode: 'plan-unknown',
		}),
	).rejects.toThrow('Stored plan is not a registered plan name.')
	expect(context.testDb.users.has('unknown-plan-invite@example.com')).toBe(
		false,
	)
	expect(logAuditEventSpy).not.toHaveBeenCalled()
})
