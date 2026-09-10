import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { RequestContext } from 'remix/router'
import { setAuthSessionSecret } from '#app/auth-session.ts'

const lifecycleMocks = vi.hoisted(() => ({
	scheduleUserCreatedEvent: vi.fn(),
}))

vi.mock('#worker/identity/schedule-user-lifecycle-event.ts', () => ({
	scheduleUserCreatedEvent: (...args: Array<unknown>) =>
		lifecycleMocks.scheduleUserCreatedEvent(...args),
	scheduleUserDeletedEvent: vi.fn(),
}))

const { createAuthHandler } = await import('#app/handlers/auth.ts')
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
import { reservedUsernamesKvKey } from '#worker/identity/reserved-username-settings.ts'

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

function createMemoryKv(initial?: Record<string, string>) {
	const store = new Map<string, string>(Object.entries(initial ?? {}))
	return {
		async get(key: string, type?: string) {
			const raw = store.get(key)
			if (raw === undefined) return null
			return type === 'json' ? JSON.parse(raw) : raw
		},
		async put(key: string, value: string) {
			store.set(key, value)
		},
	} as unknown as KVNamespace
}

function createAuthTestContext(
	options: {
		failRoleAssignment?: boolean
		emailConfigured?: boolean
		kv?: KVNamespace
		sentryEnvironment?: 'test' | 'preview' | 'production'
	} = {},
) {
	const testDb = createTestDb({
		failRoleAssignment: options.failRoleAssignment ?? false,
	})
	const handler = createAuthHandler({
		COOKIE_SECRET: testCookieSecret,
		APP_DB: testDb.db,
		SENTRY_ENVIRONMENT: options.sentryEnvironment ?? 'test',
		...(options.kv ? { BUNDLE_ARTIFACTS_KV: options.kv } : {}),
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
	utm_source: string | null
	utm_medium: string | null
	utm_campaign: string | null
	utm_content: string | null
	utm_term: string | null
	first_touch_landing_path: string | null
	first_touch_referrer: string | null
	last_active_at: string | null
}

function createTestDb(options: { failRoleAssignment?: boolean } = {}) {
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
							utm_source:
								values.utm_source == null ? null : String(values.utm_source),
							utm_medium:
								values.utm_medium == null ? null : String(values.utm_medium),
							utm_campaign:
								values.utm_campaign == null
									? null
									: String(values.utm_campaign),
							utm_content:
								values.utm_content == null ? null : String(values.utm_content),
							utm_term:
								values.utm_term == null ? null : String(values.utm_term),
							first_touch_landing_path:
								values.first_touch_landing_path == null
									? null
									: String(values.first_touch_landing_path),
							first_touch_referrer:
								values.first_touch_referrer == null
									? null
									: String(values.first_touch_referrer),
							last_active_at:
								values.last_active_at == null
									? null
									: String(values.last_active_at),
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
						if (
							normalizedQuery.includes('insert into "email_verifications"') ||
							normalizedQuery.includes('insert into email_verifications')
						) {
							return {
								results: [],
								meta: { changes: 1, last_row_id: 1 },
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
								normalizedQuery.includes('delete from email_verifications') ||
								normalizedQuery.includes('insert into "email_verifications"') ||
								normalizedQuery.includes('insert into email_verifications')
							) {
								return { meta: { changes: 1, last_row_id: 1 } }
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
			utm_source: null,
			utm_medium: null,
			utm_campaign: null,
			utm_content: null,
			utm_term: null,
			first_touch_landing_path: null,
			first_touch_referrer: null,
			last_active_at: null,
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
	const signupContext = createAuthTestContext()
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

	const openSignupResponse = await productionContext.request({
		email: 'new@example.com',
		username: 'newcomer',
		password: 'password123',
		mode: 'signup',
	})
	expect(openSignupResponse.status).toBe(200)
	expect(await openSignupResponse.json()).toEqual({
		ok: true,
		mode: 'signup',
		emailVerificationRequired: true,
		message: 'Check your email to verify your account.',
	})
	expect(productionContext.testDb.users.has('new@example.com')).toBe(true)

	// A registered address gets the accepted body and no session, so the
	// endpoint does not confirm which addresses hold accounts.
	await productionContext.testDb.addUser('taken@example.com', 'secret', 'taken')
	const blockedExistingResponse = await productionContext.request({
		email: 'taken@example.com',
		username: 'another-name',
		password: 'password123',
		mode: 'signup',
	})
	expect(blockedExistingResponse.status).toBe(200)
	expect(await blockedExistingResponse.json()).toEqual({
		ok: true,
		mode: 'signup',
		emailVerificationRequired: true,
		message: 'Check your email to verify your account.',
	})

	const weakPasswordSignupResponse = await signupContext.request({
		email: 'weak@example.com',
		username: 'weak-jane',
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
		username: 'allowed-jane',
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
		'allowed-jane',
	)
	expect(
		allowedSignupResponse.headers
			.getSetCookie()
			.some(
				(cookie) =>
					cookie.startsWith('kody_ref=') && cookie.includes('Max-Age=0'),
			),
	).toBe(true)
	// The signup context has no email sender configured, so the skipped
	// verification send logs at info level in the non-production runtime.
	expect(consoleInfo).toHaveBeenCalledWith(
		'email-verification-send-skipped',
		expect.any(Number),
	)

	await signupContext.testDb.addUser(
		'existing@example.com',
		'secret',
		'existing-jane',
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
			'Username must be 3 to 32 characters, use only letters, numbers, and hyphens, and start and end with a letter or number.',
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
		username: 'Existing-Jane',
		password: 'password123',
		mode: 'signup',
	})
	expect(duplicateUsernameResponse.status).toBe(409)
	expect(await duplicateUsernameResponse.json()).toEqual({
		error: 'Username already registered.',
	})

	// An already-registered email must be indistinguishable from a fresh
	// signup in status and body (no account enumeration); only the session
	// cookie is withheld and nothing is created.
	const duplicateEmailResponse = await signupContext.request({
		email: 'existing@example.com',
		username: 'brand-new-name',
		password: 'password123',
		mode: 'signup',
	})
	expect(duplicateEmailResponse.status).toBe(200)
	expect(await duplicateEmailResponse.json()).toEqual({
		ok: true,
		mode: 'signup',
		emailVerificationRequired: true,
		message: 'Check your email to verify your account.',
	})
	expect(duplicateEmailResponse.headers.get('Set-Cookie')).toBeNull()
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'signup',
			result: 'failure',
			reason: 'email_exists',
		}),
	)

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
	// login, the first open signup, the registered-email attempt, the
	// weak-password rejection, the second open signup, the six username
	// rejections, the duplicate-email rejection, and the three successful
	// logins.
	expect(auditEventSummaries()).toEqual([
		'login:failure',
		'signup:success',
		'signup:failure',
		'signup:failure',
		'signup:success',
		'signup:failure',
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

test('successful open signup schedules an admin user.created event', async () => {
	lifecycleMocks.scheduleUserCreatedEvent.mockClear()
	const context = createAuthTestContext()
	const email = 'newbie@example.com'
	const response = await context.request({
		email,
		username: 'newbie',
		password: 'password123',
		mode: 'signup',
	})
	expect(response.status).toBe(200)
	expect(lifecycleMocks.scheduleUserCreatedEvent).toHaveBeenCalledWith({
		env: expect.anything(),
		source: 'signup',
		user: {
			id: await createStableUserIdFromEmail(email),
			username: 'newbie',
			email,
		},
		attribution: {
			utmSource: null,
			utmMedium: null,
			utmCampaign: null,
			utmContent: null,
			utmTerm: null,
			landingPath: null,
			referrer: null,
		},
	})
})

test('password signup persists first-touch UTMs on the account once', async () => {
	lifecycleMocks.scheduleUserCreatedEvent.mockClear()
	const context = createAuthTestContext()
	const email = 'attributed@example.com'
	const response = await context.request({
		email,
		username: 'attributed',
		password: 'password123',
		mode: 'signup',
		utmSource: 'youtube',
		utmMedium: 'video',
		utmCampaign: 'bwk-2026-08-27',
		landingPath: '/signup',
		referrer: 'https://youtube.com/watch?v=abc',
	})
	expect(response.status).toBe(200)
	const user = context.testDb.users.get(email)
	expect(user).toMatchObject({
		utm_source: 'youtube',
		utm_medium: 'video',
		utm_campaign: 'bwk-2026-08-27',
		first_touch_landing_path: '/signup',
		first_touch_referrer: 'https://youtube.com/watch?v=abc',
	})
	expect(user?.last_active_at).toBeTruthy()
	expect(lifecycleMocks.scheduleUserCreatedEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			attribution: expect.objectContaining({
				utmSource: 'youtube',
				utmMedium: 'video',
				utmCampaign: 'bwk-2026-08-27',
				landingPath: '/signup',
			}),
		}),
	)
})

test('signup fails when the default user role cannot be assigned', async () => {
	const context = createAuthTestContext({
		failRoleAssignment: true,
	})

	const response = await context.request({
		email: 'roleless@example.com',
		username: 'roleless-jane',
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
		emailConfigured: true,
	})
	stubCloudflareEmailFetch({ ok: false, message: 'delivery refused' })

	const response = await context.request({
		email: 'undeliverable@example.com',
		username: 'undeliverable-jane',
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
	const context = createAuthTestContext({ sentryEnvironment: 'production' })

	const response = await context.request({
		email: 'no-sender@example.com',
		username: 'no-sender-jane',
		password: 'password123',
		mode: 'signup',
	})
	expect(response.status).toBe(500)
	expect(await response.json()).toEqual({
		error:
			'Unable to send the verification email. Please try signing up again.',
	})
	expect(context.testDb.users.has('no-sender@example.com')).toBe(false)
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

test('signup rejects KV-added reserved usernames and accepts unreserved built-ins', async () => {
	const kv = createMemoryKv({
		[reservedUsernamesKvKey]: JSON.stringify({
			added: ['brandnew'],
			removed: ['faq'],
			updatedAt: '2026-09-02T00:00:00.000Z',
			updatedBy: 'admin-stable-id',
		}),
	})
	const context = createAuthTestContext({ kv })

	const addedResponse = await context.request({
		email: 'brandnew-holder@example.com',
		username: 'brandnew',
		password: 'password123',
		mode: 'signup',
	})
	expect(addedResponse.status).toBe(400)
	expect(await addedResponse.json()).toEqual({
		error: 'This username is reserved.',
	})

	const unreservedResponse = await context.request({
		email: 'faq-holder@example.com',
		username: 'faq',
		password: 'password123',
		mode: 'signup',
	})
	expect(unreservedResponse.status).toBe(200)
	expect(await unreservedResponse.json()).toEqual({
		ok: true,
		mode: 'signup',
		emailVerificationRequired: true,
		message: 'Check your email to verify your account.',
	})
})
