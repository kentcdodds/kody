import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { HttpResponse, http } from 'msw'
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'
import { createAuthCookie, setAuthSessionSecret } from '#app/auth-session.ts'
import { createAccountConnectionsApiHandler } from '#app/handlers/account-connections.ts'
import {
	createAuthProviderCallbackHandler,
	createAuthProviderStartHandler,
	createAuthProvidersApiHandler,
} from '#app/handlers/auth-provider.ts'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'

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
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'oauth_signup',
			result: 'success',
			reason: 'provider=github',
		}),
	)

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
	// The first callback signs the user up and logs them in; the second
	// callback is a pure login. Nothing else is audited.
	expect(auditEventSummaries()).toEqual([
		'oauth_signup:success',
		'oauth_login:success',
		'oauth_login:success',
	])
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'oauth_login',
			result: 'success',
			reason: 'provider=github',
		}),
	)
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

test('JSON start mode returns the authorize URL for client-side navigation', async () => {
	const { db } = createMigratedDb()
	const env = createAppEnv(db)

	// The first-party UI fetches the start endpoint (Accept: json) and
	// navigates itself because the CSP blocks form-POST and fetch-followed
	// redirects to the provider origin.
	const response = await runHandler(
		createAuthProviderStartHandler(env),
		new Request('http://example.com/auth/github?redirectTo=%2Fcommunity', {
			method: 'POST',
			headers: { Accept: 'application/json' },
		}),
		{ provider: 'github' },
	)
	expect(response.status).toBe(200)
	const payload = (await response.json()) as {
		ok: boolean
		authorizeUrl: string
	}
	expect(payload.ok).toBe(true)
	expect(payload.authorizeUrl).toContain(
		'https://github.com/login/oauth/authorize',
	)
	expect(response.headers.get('Set-Cookie')).toContain('kody_oauth_login=')

	const unknownProviderResponse = await runHandler(
		createAuthProviderStartHandler(env),
		new Request('http://example.com/auth/nope', {
			method: 'POST',
			headers: { Accept: 'application/json' },
		}),
		{ provider: 'nope' },
	)
	expect(unknownProviderResponse.status).toBe(400)
	expect(await unknownProviderResponse.json()).toEqual({
		ok: false,
		code: 'unknown-provider',
		error: 'That sign-in provider is not supported.',
	})
})

test('signed-in users link and disconnect providers from their account', async () => {
	const { sqlite, db } = createMigratedDb()
	const env = createAppEnv(db, {
		GITHUB_CLIENT_ID: 'MOCK_GITHUB_CLIENT_ID',
		GITHUB_CLIENT_SECRET: 'MOCK_GITHUB_CLIENT_SECRET',
	})
	await seedUser(sqlite, {
		id: 11,
		email: 'linker@example.com',
		username: 'linker',
	})
	const sessionCookiePair = getCookiePair(
		await createAuthCookie(
			{ id: '11', email: 'linker@example.com', rememberMe: false },
			false,
		),
	)

	// Linking: signed-in start + callback attaches the identity to the
	// current account instead of creating or switching accounts.
	const start = await startProviderFlow(
		env,
		'github',
		'http://example.com/auth/github',
	)
	const callbackHandler = createAuthProviderCallbackHandler(env)
	const linkResponse = await runHandler(
		callbackHandler,
		new Request(start.location, {
			headers: { Cookie: `${start.stateCookie}; ${sessionCookiePair}` },
		}),
		{ provider: 'github' },
	)
	expect(linkResponse.status).toBe(302)
	expect(linkResponse.headers.get('Location')).toBe(
		'/account?oauthLinked=github',
	)
	const connection = sqlite
		.prepare(
			`SELECT user_id FROM oauth_connections WHERE provider_name = 'github'`,
		)
		.get() as { user_id: number }
	expect(connection.user_id).toBe(11)

	// Re-linking the same identity is a no-op success.
	const secondStart = await startProviderFlow(
		env,
		'github',
		'http://example.com/auth/github',
	)
	const relinkResponse = await runHandler(
		callbackHandler,
		new Request(secondStart.location, {
			headers: { Cookie: `${secondStart.stateCookie}; ${sessionCookiePair}` },
		}),
		{ provider: 'github' },
	)
	expect(relinkResponse.headers.get('Location')).toBe(
		'/account?oauthLinked=github',
	)

	// The same provider identity linked to a different signed-in user is a
	// conflict surfaced on the account page, never an account switch.
	await seedUser(sqlite, {
		id: 12,
		email: 'other@example.com',
		username: 'other-user',
	})
	const otherSessionCookiePair = getCookiePair(
		await createAuthCookie(
			{ id: '12', email: 'other@example.com', rememberMe: false },
			false,
		),
	)
	const conflictStart = await startProviderFlow(
		env,
		'github',
		'http://example.com/auth/github',
	)
	const conflictResponse = await runHandler(
		callbackHandler,
		new Request(conflictStart.location, {
			headers: {
				Cookie: `${conflictStart.stateCookie}; ${otherSessionCookiePair}`,
			},
		}),
		{ provider: 'github' },
	)
	expect(conflictResponse.headers.get('Location')).toBe(
		'/account?oauthError=connection-conflict',
	)

	// The connections API lists the link; disconnecting the only connection
	// is allowed here because the seeded user has a usable password.
	const connectionsHandler = createAccountConnectionsApiHandler(env)
	const listResponse = await runHandler(
		connectionsHandler,
		new Request('http://example.com/account/connections.json', {
			headers: { Cookie: sessionCookiePair, Accept: 'application/json' },
		}),
	)
	const listPayload = (await listResponse.json()) as {
		ok: boolean
		connections: Array<{ provider: string; displayName: string | null }>
		canDisconnect: boolean
		availableProviders: Array<{ id: string }>
	}
	expect(listPayload.ok).toBe(true)
	expect(listPayload.connections).toHaveLength(1)
	expect(listPayload.connections[0]?.provider).toBe('github')
	expect(listPayload.canDisconnect).toBe(true)
	expect(listPayload.availableProviders.map((p) => p.id)).toEqual([
		'google',
		'x',
	])

	const disconnectResponse = await runHandler(
		connectionsHandler,
		new Request('http://example.com/account/connections.json', {
			method: 'POST',
			headers: {
				Cookie: sessionCookiePair,
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ intent: 'disconnect', provider: 'github' }),
		}),
	)
	const disconnectPayload = (await disconnectResponse.json()) as {
		ok: boolean
		connections: Array<unknown>
	}
	expect(disconnectPayload.ok).toBe(true)
	expect(disconnectPayload.connections).toHaveLength(0)
	expect(
		sqlite.prepare(`SELECT COUNT(*) AS count FROM oauth_connections`).get(),
	).toEqual({ count: 0 })
})

test('disconnect is refused when the connection is the only sign-in method', async () => {
	const { sqlite, db } = createMigratedDb()
	const env = createAppEnv(db, {
		GITHUB_CLIENT_ID: 'MOCK_GITHUB_CLIENT_ID',
		GITHUB_CLIENT_SECRET: 'MOCK_GITHUB_CLIENT_SECRET',
	})

	// Create an account through mock social signup: it has no usable
	// password, so its single connection must not be removable.
	const start = await startProviderFlow(
		env,
		'github',
		'http://example.com/auth/github',
	)
	const signupResponse = await runHandler(
		createAuthProviderCallbackHandler(env),
		new Request(start.location, { headers: { Cookie: start.stateCookie } }),
		{ provider: 'github' },
	)
	const sessionCookiePair = (signupResponse.headers.getSetCookie() ?? [])
		.map(getCookiePair)
		.find((pair) => pair.startsWith('kody_session='))
	expect(sessionCookiePair).toBeTruthy()

	const connectionsHandler = createAccountConnectionsApiHandler(env)
	const listResponse = await runHandler(
		connectionsHandler,
		new Request('http://example.com/account/connections.json', {
			headers: { Cookie: sessionCookiePair ?? '', Accept: 'application/json' },
		}),
	)
	const listPayload = (await listResponse.json()) as { canDisconnect: boolean }
	expect(listPayload.canDisconnect).toBe(false)

	const disconnectResponse = await runHandler(
		connectionsHandler,
		new Request('http://example.com/account/connections.json', {
			method: 'POST',
			headers: {
				Cookie: sessionCookiePair ?? '',
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ intent: 'disconnect', provider: 'github' }),
		}),
	)
	expect(disconnectResponse.status).toBe(400)
	expect(
		sqlite.prepare(`SELECT COUNT(*) AS count FROM oauth_connections`).get(),
	).toEqual({ count: 1 })
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

function seedInvite(sqlite: DatabaseSync, code: string, maxUses = 1) {
	sqlite.exec(`
		INSERT INTO invites (code, created_by, note, max_uses, use_count)
		VALUES (${quoteSqlString(code)}, NULL, '', ${maxUses}, 0);
	`)
}

function mockGithubProfileExchange(email = 'octo@example.com') {
	msw.use(
		http.post('https://github.com/login/oauth/access_token', async () =>
			HttpResponse.json({ access_token: 'github-access-token' }),
		),
		http.get('https://api.github.com/user', () =>
			HttpResponse.json({
				id: 99001,
				login: 'octo-cat',
				name: 'Octo Cat',
				email: null,
			}),
		),
		http.get('https://api.github.com/user/emails', () =>
			HttpResponse.json([{ email, primary: true, verified: true }]),
		),
	)
}

test('production OAuth signup is invite-gated while existing connections still log in', async () => {
	const missingInvite = createMigratedDb()
	const missingInviteEnv = createAppEnv(missingInvite.db, {
		SENTRY_ENVIRONMENT: 'production',
	})
	mockGithubProfileExchange()
	const missingStart = await startProviderFlow(
		missingInviteEnv,
		'github',
		'http://example.com/auth/github',
	)
	const missingCallback = await runHandler(
		createAuthProviderCallbackHandler(missingInviteEnv),
		new Request(
			`http://example.com/auth/github/callback?code=github-auth-code&state=${missingStart.state}`,
			{ headers: { Cookie: missingStart.stateCookie } },
		),
		{ provider: 'github' },
	)
	expect(missingCallback.status).toBe(302)
	expect(missingCallback.headers.get('Location')).toBe(
		'/login?oauthError=invite-required',
	)
	expect(
		missingInvite.sqlite.prepare(`SELECT COUNT(*) AS count FROM users`).get(),
	).toEqual({ count: 0 })

	const invalidInvite = createMigratedDb()
	const invalidInviteEnv = createAppEnv(invalidInvite.db, {
		SENTRY_ENVIRONMENT: 'production',
	})
	mockGithubProfileExchange()
	const invalidStart = await startProviderFlow(
		invalidInviteEnv,
		'github',
		'http://example.com/auth/github?inviteCode=not-a-real-invite',
	)
	const invalidCallback = await runHandler(
		createAuthProviderCallbackHandler(invalidInviteEnv),
		new Request(
			`http://example.com/auth/github/callback?code=github-auth-code&state=${invalidStart.state}`,
			{ headers: { Cookie: invalidStart.stateCookie } },
		),
		{ provider: 'github' },
	)
	expect(invalidCallback.status).toBe(302)
	expect(invalidCallback.headers.get('Location')).toBe(
		'/login?oauthError=invite-invalid',
	)
	expect(
		invalidInvite.sqlite.prepare(`SELECT COUNT(*) AS count FROM users`).get(),
	).toEqual({ count: 0 })

	const invitedSignup = createMigratedDb()
	const invitedEnv = createAppEnv(invitedSignup.db, {
		SENTRY_ENVIRONMENT: 'production',
	})
	seedInvite(invitedSignup.sqlite, 'SOCIAL-INVITE')
	mockGithubProfileExchange('social-invited@example.com')
	const invitedStart = await startProviderFlow(
		invitedEnv,
		'github',
		'http://example.com/auth/github?inviteCode=social-invite',
	)
	const invitedCallback = await runHandler(
		createAuthProviderCallbackHandler(invitedEnv),
		new Request(
			`http://example.com/auth/github/callback?code=github-auth-code&state=${invitedStart.state}`,
			{ headers: { Cookie: invitedStart.stateCookie } },
		),
		{ provider: 'github' },
	)
	expect(invitedCallback.status).toBe(302)
	expect(invitedCallback.headers.get('Location')).toBe('/account')
	const user = invitedSignup.sqlite
		.prepare(`SELECT * FROM users WHERE email = ?`)
		.get('social-invited@example.com') as Record<string, unknown>
	expect(user).toBeTruthy()
	expect(user.email_verified_at).toBeTruthy()
	expect(
		invitedSignup.sqlite
			.prepare(`SELECT use_count FROM invites WHERE code = ?`)
			.get('SOCIAL-INVITE'),
	).toEqual({ use_count: 1 })
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'oauth_signup',
			result: 'success',
		}),
	)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'invite_use',
			result: 'success',
			reason: expect.stringContaining('invite_code=SOCIAL-INVITE'),
		}),
	)

	const existingLogin = createMigratedDb()
	const existingEnv = createAppEnv(existingLogin.db, {
		SENTRY_ENVIRONMENT: 'production',
	})
	await seedUser(existingLogin.sqlite, {
		id: 11,
		email: 'existing-oauth@example.com',
		username: 'existing-oauth',
	})
	existingLogin.sqlite.exec(`
		INSERT INTO oauth_connections (provider_name, provider_id, user_id, provider_display_name)
		VALUES ('github', '99001', 11, 'existing-oauth');
	`)
	mockGithubProfileExchange('existing-oauth@example.com')
	const existingStart = await startProviderFlow(
		existingEnv,
		'github',
		'http://example.com/auth/github',
	)
	const existingCallback = await runHandler(
		createAuthProviderCallbackHandler(existingEnv),
		new Request(
			`http://example.com/auth/github/callback?code=github-auth-code&state=${existingStart.state}`,
			{ headers: { Cookie: existingStart.stateCookie } },
		),
		{ provider: 'github' },
	)
	expect(existingCallback.status).toBe(302)
	expect(existingCallback.headers.get('Location')).toBe('/account')
	expect(
		existingCallback.headers
			.getSetCookie()
			.some((cookie) => cookie.startsWith('kody_session=')),
	).toBe(true)
	expect(
		existingLogin.sqlite.prepare(`SELECT COUNT(*) AS count FROM users`).get(),
	).toEqual({ count: 1 })
})
