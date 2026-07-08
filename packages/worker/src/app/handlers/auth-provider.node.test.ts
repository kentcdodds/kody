import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { HttpResponse, http } from 'msw'
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import {
	createAuthProviderCallbackHandler,
	createAuthProviderStartHandler,
	createAuthProvidersApiHandler,
} from '#app/handlers/auth-provider.ts'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

const msw = createMswNodeServer()

beforeAll(() => {
	setAuthSessionSecret(testCookieSecret)
})

afterEach(() => {
	msw.resetHandlers()
})

afterAll(() => {
	msw.close()
})

function applyMigrations(db: DatabaseSync) {
	const migrationsDir = new URL('../../../migrations/', import.meta.url)
	for (const fileName of readdirSync(migrationsDir)
		.filter((file) => file.endsWith('.sql'))
		.sort()) {
		db.exec(readFileSync(new URL(fileName, migrationsDir), 'utf8'))
	}
}

function createD1FromSqlite(db: DatabaseSync) {
	function createPreparedStatement(query: string) {
		return {
			query,
			bind(...params: Array<unknown>) {
				return {
					query,
					async all<T>() {
						const statement = db.prepare(query)
						const rows = statement.all(...params) as Array<T>
						return {
							results: rows,
							meta: { changes: 0, last_row_id: 0 },
						}
					},
					async first<T>() {
						const statement = db.prepare(query)
						return (statement.get(...params) ?? null) as T | null
					},
					async run() {
						const statement = db.prepare(query)
						const result = statement.run(...params)
						return {
							meta: {
								changes: result.changes,
								last_row_id: Number(result.lastInsertRowid),
							},
						}
					},
				}
			},
			async all<T>() {
				const statement = db.prepare(query)
				const rows = statement.all() as Array<T>
				return {
					results: rows,
					meta: { changes: 0, last_row_id: 0 },
				}
			},
			async first<T>() {
				const statement = db.prepare(query)
				return (statement.get() ?? null) as T | null
			},
			async run() {
				const statement = db.prepare(query)
				const result = statement.run()
				return {
					meta: {
						changes: result.changes,
						last_row_id: Number(result.lastInsertRowid),
					},
				}
			},
		}
	}
	return {
		prepare: createPreparedStatement,
		async exec(query: string) {
			db.exec(query)
		},
	} as unknown as D1Database
}

function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyMigrations(sqlite)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

async function seedUser(
	sqlite: DatabaseSync,
	input: { id: number; email: string; username: string },
) {
	const passwordHash = await createPasswordHash('test-password')
	const stableUserId = await createStableUserIdFromEmail(input.email)
	sqlite.exec(`
		INSERT INTO users (id, username, email, stable_user_id, password_hash)
		VALUES (
			${input.id},
			${quoteSqlString(input.username)},
			${quoteSqlString(input.email)},
			${quoteSqlString(stableUserId)},
			${quoteSqlString(passwordHash)}
		);
	`)
}

function createAppEnv(
	db: D1Database,
	overrides: Record<string, string> = {},
): Env {
	return {
		APP_DB: db,
		COOKIE_SECRET: testCookieSecret,
		SENTRY_ENVIRONMENT: 'test',
		GITHUB_CLIENT_ID: 'github-client-id-test',
		GITHUB_CLIENT_SECRET: 'github-client-secret-test',
		GOOGLE_CLIENT_ID: 'google-client-id-test',
		GOOGLE_CLIENT_SECRET: 'google-client-secret-test',
		X_CLIENT_ID: 'x-client-id-test',
		X_CLIENT_SECRET: 'x-client-secret-test',
		...overrides,
	} as unknown as Env
}

type Handler = {
	handler(context: never): Promise<Response>
}

async function runHandler(
	handler: Handler,
	request: Request,
	params: Record<string, string> = {},
): Promise<Response> {
	return handler.handler({
		request,
		url: new URL(request.url),
		params,
	} as never)
}

function getCookiePair(setCookieHeader: string) {
	const pair = setCookieHeader.split(';')[0]
	if (!pair) throw new Error(`Unexpected Set-Cookie header: ${setCookieHeader}`)
	return pair
}

async function startProviderFlow(env: Env, provider: string, url: string) {
	const startResponse = await runHandler(
		createAuthProviderStartHandler(env),
		new Request(url, { method: 'POST' }),
		{ provider },
	)
	expect(startResponse.status).toBe(302)
	const location = startResponse.headers.get('Location') ?? ''
	const stateCookie = getCookiePair(
		startResponse.headers.get('Set-Cookie') ?? '',
	)
	const state = new URL(location).searchParams.get('state') ?? ''
	return { location, stateCookie, state }
}

test('providers api lists only configured providers', async () => {
	const { db } = createMigratedDb()
	const allEnabled = await runHandler(
		createAuthProvidersApiHandler(createAppEnv(db)),
		new Request('http://example.com/auth/providers.json'),
	)
	expect(await allEnabled.json()).toEqual({
		ok: true,
		providers: [
			{ id: 'github', label: 'GitHub' },
			{ id: 'google', label: 'Google' },
			{ id: 'x', label: 'X' },
		],
	})

	const githubOnly = await runHandler(
		createAuthProvidersApiHandler(
			createAppEnv(db, {
				GOOGLE_CLIENT_ID: '',
				GOOGLE_CLIENT_SECRET: '',
				X_CLIENT_ID: '',
				X_CLIENT_SECRET: '',
			}),
		),
		new Request('http://example.com/auth/providers.json'),
	)
	expect(await githubOnly.json()).toEqual({
		ok: true,
		providers: [{ id: 'github', label: 'GitHub' }],
	})
})

test('github sign-in creates a verified account, then signs it back in', async () => {
	const { sqlite, db } = createMigratedDb()
	const env = createAppEnv(db)

	msw.use(
		http.post(
			'https://github.com/login/oauth/access_token',
			async ({ request }) => {
				const body = new URLSearchParams(await request.text())
				expect(body.get('client_id')).toBe('github-client-id-test')
				expect(body.get('client_secret')).toBe('github-client-secret-test')
				expect(body.get('code')).toBe('github-auth-code')
				return HttpResponse.json({ access_token: 'github-access-token' })
			},
		),
		http.get('https://api.github.com/user', ({ request }) => {
			expect(request.headers.get('Authorization')).toBe(
				'Bearer github-access-token',
			)
			return HttpResponse.json({
				id: 99001,
				login: 'octo-cat',
				name: 'Octo Cat',
				email: null,
			})
		}),
		http.get('https://api.github.com/user/emails', () =>
			HttpResponse.json([
				{ email: 'unverified@example.com', primary: false, verified: false },
				{ email: 'octo@example.com', primary: true, verified: true },
			]),
		),
	)

	const start = await startProviderFlow(
		env,
		'github',
		'http://example.com/auth/github?redirectTo=%2Fcommunity',
	)
	expect(start.location).toContain('https://github.com/login/oauth/authorize')
	expect(start.location).toContain('client_id=github-client-id-test')
	expect(start.stateCookie).toContain('kody_oauth_login=')
	expect(start.state.length).toBeGreaterThan(0)

	const callbackHandler = createAuthProviderCallbackHandler(env)
	const callbackResponse = await runHandler(
		callbackHandler,
		new Request(
			`http://example.com/auth/github/callback?code=github-auth-code&state=${start.state}`,
			{ headers: { Cookie: start.stateCookie } },
		),
		{ provider: 'github' },
	)
	expect(callbackResponse.status).toBe(302)
	expect(callbackResponse.headers.get('Location')).toBe('/community')
	const setCookies = callbackResponse.headers.getSetCookie()
	expect(setCookies.some((cookie) => cookie.startsWith('kody_session='))).toBe(
		true,
	)
	// The one-shot state cookie is cleared on the callback response.
	expect(
		setCookies.some(
			(cookie) =>
				cookie.startsWith('kody_oauth_login=') && cookie.includes('Max-Age=0'),
		),
	).toBe(true)

	const user = sqlite
		.prepare(`SELECT * FROM users WHERE email = ?`)
		.get('octo@example.com') as Record<string, unknown>
	expect(user).toBeTruthy()
	expect(user.username).toBe('octo-cat')
	// Provider-verified email skips the verification-email flow.
	expect(user.email_verified_at).toBeTruthy()
	const roleCount = sqlite
		.prepare(
			`SELECT COUNT(*) AS count FROM user_roles
			 JOIN roles ON roles.id = user_roles.role_id
			 WHERE user_roles.user_id = ? AND roles.name = 'user'`,
		)
		.get(user.id as number) as { count: number }
	expect(roleCount.count).toBe(1)
	const connection = sqlite
		.prepare(
			`SELECT * FROM oauth_connections WHERE provider_name = 'github' AND provider_id = '99001'`,
		)
		.get() as Record<string, unknown>
	expect(connection.user_id).toBe(user.id)

	// A second sign-in with the same provider identity reuses the account.
	const secondStart = await startProviderFlow(
		env,
		'github',
		'http://example.com/auth/github',
	)
	const secondCallback = await runHandler(
		callbackHandler,
		new Request(
			`http://example.com/auth/github/callback?code=github-auth-code&state=${secondStart.state}`,
			{ headers: { Cookie: secondStart.stateCookie } },
		),
		{ provider: 'github' },
	)
	expect(secondCallback.status).toBe(302)
	expect(secondCallback.headers.get('Location')).toBe('/account')
	expect(
		secondCallback.headers
			.getSetCookie()
			.some((cookie) => cookie.startsWith('kody_session=')),
	).toBe(true)
	const userCount = sqlite
		.prepare(`SELECT COUNT(*) AS count FROM users`)
		.get() as { count: number }
	expect(userCount.count).toBe(1)
})

test('google sign-in links a matching verified email to the existing account', async () => {
	const { sqlite, db } = createMigratedDb()
	const env = createAppEnv(db)
	await seedUser(sqlite, {
		id: 7,
		email: 'existing@example.com',
		username: 'existing-user',
	})

	msw.use(
		http.post('https://oauth2.googleapis.com/token', async ({ request }) => {
			const body = new URLSearchParams(await request.text())
			expect(body.get('code')).toBe('google-auth-code')
			// Google uses PKCE; the callback replays the verifier from the
			// signed state cookie.
			expect(body.get('code_verifier')?.length).toBeGreaterThan(0)
			return HttpResponse.json({ access_token: 'google-access-token' })
		}),
		http.get('https://openidconnect.googleapis.com/v1/userinfo', () =>
			HttpResponse.json({
				sub: 'google-sub-123',
				email: 'existing@example.com',
				email_verified: true,
				name: 'Existing User',
			}),
		),
	)

	const start = await startProviderFlow(
		env,
		'google',
		'http://example.com/auth/google',
	)
	expect(start.location).toContain(
		'https://accounts.google.com/o/oauth2/v2/auth',
	)
	expect(start.location).toContain('code_challenge_method=S256')

	const callbackResponse = await runHandler(
		createAuthProviderCallbackHandler(env),
		new Request(
			`http://example.com/auth/google/callback?code=google-auth-code&state=${start.state}`,
			{ headers: { Cookie: start.stateCookie } },
		),
		{ provider: 'google' },
	)
	expect(callbackResponse.status).toBe(302)
	expect(callbackResponse.headers.get('Location')).toBe('/account')
	expect(
		callbackResponse.headers
			.getSetCookie()
			.some((cookie) => cookie.startsWith('kody_session=')),
	).toBe(true)

	const connection = sqlite
		.prepare(
			`SELECT * FROM oauth_connections WHERE provider_name = 'google' AND provider_id = 'google-sub-123'`,
		)
		.get() as Record<string, unknown>
	expect(connection.user_id).toBe(7)
	// The provider verified the exact account email, so the account is
	// treated as email-verified.
	const user = sqlite
		.prepare(`SELECT email_verified_at FROM users WHERE id = 7`)
		.get() as { email_verified_at: string | null }
	expect(user.email_verified_at).toBeTruthy()
	const userCount = sqlite
		.prepare(`SELECT COUNT(*) AS count FROM users`)
		.get() as { count: number }
	expect(userCount.count).toBe(1)
})

test('x sign-in without a shared email fails with a helpful error', async () => {
	const { sqlite, db } = createMigratedDb()
	const env = createAppEnv(db)

	msw.use(
		http.post('https://api.x.com/2/oauth2/token', ({ request }) => {
			// X wants confidential-client credentials via HTTP Basic.
			expect(request.headers.get('Authorization')).toBe(
				`Basic ${btoa('x-client-id-test:x-client-secret-test')}`,
			)
			return HttpResponse.json({ access_token: 'x-access-token' })
		}),
		http.get('https://api.x.com/2/users/me', () =>
			HttpResponse.json({
				data: { id: 'x-user-9', name: 'X User', username: 'xuser' },
			}),
		),
	)

	const start = await startProviderFlow(env, 'x', 'http://example.com/auth/x')
	const callbackResponse = await runHandler(
		createAuthProviderCallbackHandler(env),
		new Request(
			`http://example.com/auth/x/callback?code=x-auth-code&state=${start.state}`,
			{ headers: { Cookie: start.stateCookie } },
		),
		{ provider: 'x' },
	)
	expect(callbackResponse.status).toBe(302)
	expect(callbackResponse.headers.get('Location')).toBe(
		'/login?oauthError=no-verified-email',
	)
	const userCount = sqlite
		.prepare(`SELECT COUNT(*) AS count FROM users`)
		.get() as { count: number }
	expect(userCount.count).toBe(0)
})

test('callback rejects a state mismatch', async () => {
	const { db } = createMigratedDb()
	const env = createAppEnv(db)

	const start = await startProviderFlow(
		env,
		'github',
		'http://example.com/auth/github?redirectTo=%2Fcommunity',
	)
	const callbackResponse = await runHandler(
		createAuthProviderCallbackHandler(env),
		new Request(
			`http://example.com/auth/github/callback?code=github-auth-code&state=not-the-state`,
			{ headers: { Cookie: start.stateCookie } },
		),
		{ provider: 'github' },
	)
	expect(callbackResponse.status).toBe(302)
	// The deep-link target survives the failure so a retry from the login
	// page still lands where the user was headed.
	expect(callbackResponse.headers.get('Location')).toBe(
		'/login?oauthError=state-mismatch&redirectTo=%2Fcommunity',
	)
})

test('MOCK_ client ids run the whole flow in-worker without network access', async () => {
	const { sqlite, db } = createMigratedDb()
	// onUnhandledRequest: 'error' in the shared MSW server means any real
	// provider call would fail this test.
	const env = createAppEnv(db, {
		GITHUB_CLIENT_ID: 'MOCK_GITHUB_CLIENT_ID',
		GITHUB_CLIENT_SECRET: 'MOCK_GITHUB_CLIENT_SECRET',
	})

	const start = await startProviderFlow(
		env,
		'github',
		'http://example.com/auth/github',
	)
	// Mock mode redirects straight back to the callback with a mock code.
	const callbackUrl = new URL(start.location)
	expect(callbackUrl.pathname).toBe('/auth/github/callback')
	expect(callbackUrl.searchParams.get('state')).toBe(start.state)

	const callbackResponse = await runHandler(
		createAuthProviderCallbackHandler(env),
		new Request(start.location, { headers: { Cookie: start.stateCookie } }),
		{ provider: 'github' },
	)
	expect(callbackResponse.status).toBe(302)
	expect(callbackResponse.headers.get('Location')).toBe('/account')
	const user = sqlite
		.prepare(`SELECT * FROM users WHERE email = ?`)
		.get('mock-github-user@example.com') as Record<string, unknown>
	expect(user).toBeTruthy()
	expect(user.username).toBe('mock-github-user')
})
