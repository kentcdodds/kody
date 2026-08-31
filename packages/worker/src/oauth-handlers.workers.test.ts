import { expect, test, vi } from 'vitest'
import * as Sentry from '@sentry/cloudflare'
import {
	type AuthRequest,
	type ClientInfo,
	type CompleteAuthorizationOptions,
	type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider'
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	createAuthCookie,
	readAuthSessionResult,
	setAuthSessionSecret,
} from '#app/auth-session.ts'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { invalidClientIdMismatchMessage } from '@kody-internal/shared/oauth-messages.ts'
import {
	handleAuthorizeInfo,
	handleAuthorizeRequest,
	oauthEmailVerificationRequiredMessage,
	oauthScopes,
} from './oauth-handlers.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'

const baseAuthRequest: AuthRequest = {
	responseType: 'code',
	clientId: 'client-123',
	redirectUri: 'https://example.com/callback',
	scope: ['profile'],
	state: 'demo',
}

const baseClient: ClientInfo = {
	clientId: 'client-123',
	redirectUris: ['https://example.com/callback'],
	clientName: 'kody Demo',
	tokenEndpointAuthMethod: 'client_secret_basic',
}
const cookieSecret = 'test-secret-0123456789abcdef0123456789'
const claudeAuthorizeUrl =
	'https://heykody.dev/oauth/authorize?response_type=code&client_id=ZlV_ZKY8Xe1Hnw2a&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&code_challenge=sp23xso5O3jXO-73NoQqSxwu742uqSbPXw1VA8jRfNE&code_challenge_method=S256&state=x5z9jORTCRNTmZ5_fiH7tdVWDVbiPujOHtUkyHzBvmc&scope=profile+email&resource=https%3A%2F%2Fheykody.dev%2Fmcp'
const claudeAuthRequest: AuthRequest = {
	responseType: 'code',
	clientId: 'ZlV_ZKY8Xe1Hnw2a',
	redirectUri: 'https://claude.ai/api/mcp/auth_callback',
	scope: ['profile', 'email'],
	state: 'x5z9jORTCRNTmZ5_fiH7tdVWDVbiPujOHtUkyHzBvmc',
	codeChallenge: 'sp23xso5O3jXO-73NoQqSxwu742uqSbPXw1VA8jRfNE',
	codeChallengeMethod: 'S256',
	resource: 'https://heykody.dev/mcp',
}
const claudeClient: ClientInfo = {
	clientId: claudeAuthRequest.clientId,
	redirectUris: [claudeAuthRequest.redirectUri],
	clientName: 'Claude',
	tokenEndpointAuthMethod: 'none',
}
// Gemini Spark custom MCP apps omit RFC 8707 `resource` on authorize.
const geminiAuthorizeUrl =
	'https://heykody.dev/oauth/authorize?response_type=code&client_id=QuXak4ugdtPZncjp&redirect_uri=https%3A%2F%2Foauth-redirect.googleusercontent.com%2Fr%2Fuser_bound_custom-mcp-106664623666703652842-heykody_dev&scope=profile+email&code_challenge=uMIae0HtFCz1_e_KxVlJ_W2oz1eT87iC0h4WkBB4tEc&code_challenge_method=S256&state=gemini-demo-state'
const geminiAuthRequestWithoutResource: AuthRequest = {
	responseType: 'code',
	clientId: 'QuXak4ugdtPZncjp',
	redirectUri:
		'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-106664623666703652842-heykody_dev',
	scope: ['profile', 'email'],
	state: 'gemini-demo-state',
	codeChallenge: 'uMIae0HtFCz1_e_KxVlJ_W2oz1eT87iC0h4WkBB4tEc',
	codeChallengeMethod: 'S256',
}
const geminiClient: ClientInfo = {
	clientId: geminiAuthRequestWithoutResource.clientId,
	redirectUris: [geminiAuthRequestWithoutResource.redirectUri],
	clientName: 'Gemini',
	tokenEndpointAuthMethod: 'none',
}

function createHelpers(overrides: Partial<OAuthHelpers> = {}): OAuthHelpers {
	return {
		parseAuthRequest: async () => baseAuthRequest,
		lookupClient: async () => baseClient,
		completeAuthorization: async () => ({
			redirectTo: 'https://example.com/callback?code=demo',
		}),
		async createClient() {
			throw new Error('Not implemented')
		},
		listClients: async () => ({ items: [] }),
		updateClient: async () => null,
		deleteClient: async () => undefined,
		listUserGrants: async () => ({ items: [] }),
		revokeGrant: async () => undefined,
		unwrapToken: async () => null,
		async exchangeToken() {
			throw new Error('Not implemented')
		},
		purgeExpiredData: async () => ({
			grantsChecked: 0,
			grantsPurged: 0,
			tokensChecked: 0,
			tokensPurged: 0,
			done: true,
		}),
		...overrides,
	}
}

async function createDatabase(
	password: string,
	options: {
		emailVerifiedAt?: string | null
		ownedClientIds?: ReadonlyArray<string>
	} = {},
) {
	const passwordHash = await createPasswordHash(password)
	const email = 'user@example.com'
	const stableUserId = await createStableUserIdFromEmail(email)
	const emailVerifiedAt =
		options.emailVerifiedAt === undefined
			? new Date(0).toISOString()
			: options.emailVerifiedAt
	const userRow = {
		id: 1,
		username: 'test-user',
		email,
		password_hash: passwordHash,
		email_verified_at: emailVerifiedAt,
		stable_user_id: stableUserId,
	}
	return {
		prepare(query: string) {
			// The 2FA gate queries verifications during inline OAuth login; the
			// mocked user has no verification rows, so those queries are empty.
			const isVerificationsQuery = query.includes('FROM verifications')
			const isOwnedClientQuery = query.includes('FROM user_mcp_oauth_clients')
			const isEmailVerifiedQuery =
				query.includes('email_verified_at') && !query.includes('stable_user_id')
			let bound: Array<unknown> = []
			const statement = {
				bind(...params: Array<unknown>) {
					bound = params
					return statement
				},
				async all() {
					return {
						results: isVerificationsQuery ? [] : [userRow],
						meta: { changes: 0, last_row_id: 0 },
					}
				},
				async first() {
					if (isVerificationsQuery) return null
					if (isOwnedClientQuery) {
						const clientId = bound.find((value) => typeof value === 'string')
						if (
							typeof clientId === 'string' &&
							options.ownedClientIds?.includes(clientId)
						) {
							return { client_id: clientId }
						}
						return null
					}
					if (isEmailVerifiedQuery) {
						return { email_verified_at: emailVerifiedAt }
					}
					return userRow
				},
				async run() {
					return { meta: { changes: 1, last_row_id: 1 } }
				},
			}
			return statement
		},
		async exec() {
			return
		},
	} as unknown as D1Database
}

function mockJobDoNamespace(id: string): DurableObjectNamespace {
	return {
		idFromName() {
			return { toString: () => id } as DurableObjectId
		},
		get() {
			return {} as DurableObjectStub
		},
	} as unknown as DurableObjectNamespace
}

function createEnv(
	helpers: OAuthHelpers,
	appDb?: D1Database,
	cookieSecretValue: string = cookieSecret,
) {
	const resolvedDb = appDb ?? ({} as D1Database)
	return {
		OAUTH_PROVIDER: helpers,
		APP_DB: resolvedDb,
		BUNDLE_ARTIFACTS_KV: {
			get: async () => null,
			put: async () => undefined,
			delete: async () => undefined,
		},
		COOKIE_SECRET: cookieSecretValue,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		JOB_MANAGER: mockJobDoNamespace('job-manager-test-id'),
		STORAGE_RUNNER: mockJobDoNamespace('storage-runner-test-id'),
		PACKAGE_REALTIME_SESSION: mockJobDoNamespace(
			'package-realtime-session-test-id',
		),
		MCP_CLIENT_HUB: mockJobDoNamespace('mcp-client-hub-test-id'),
	} as unknown as Env
}

async function workerFetch(
	request: Request,
	workerEnv: Env = env,
): Promise<Response> {
	const ctx = createExecutionContext()
	const response = await exports.default.fetch(request, workerEnv, ctx)
	await waitOnExecutionContext(ctx)
	return response
}

async function createS256CodeChallenge(verifier: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(verifier),
	)
	return btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '')
}

async function createSha256Hex(value: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(value),
	)
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}

async function seedWorkerUser(
	email: string,
	password: string,
	options: { emailVerifiedAt?: string | null } = {},
) {
	const passwordHash = await createPasswordHash(password)
	const stableUserId = await createStableUserIdFromEmail(email)
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS users (
			id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
			username TEXT NOT NULL UNIQUE,
			email TEXT NOT NULL UNIQUE,
			password_hash TEXT NOT NULL,
			email_verified_at TEXT,
			stable_user_id TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
			updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		)`,
	).run()
	try {
		await env.APP_DB.prepare(
			`ALTER TABLE users ADD COLUMN stable_user_id TEXT`,
		).run()
	} catch {
		// Column already present on a fresh CREATE above.
	}
	// The inline OAuth login checks two-factor status, which queries the
	// verifications table (empty here: no seeded user has 2FA enabled).
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS verifications (
			id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
			type TEXT NOT NULL,
			target TEXT NOT NULL,
			secret TEXT NOT NULL,
			algorithm TEXT NOT NULL,
			digits INTEGER NOT NULL,
			period INTEGER NOT NULL,
			char_set TEXT NOT NULL,
			expires_at INTEGER,
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
			UNIQUE (target, type)
		)`,
	).run()
	const emailVerifiedAt =
		options.emailVerifiedAt === undefined
			? new Date(0).toISOString()
			: options.emailVerifiedAt
	const result = await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(email) DO UPDATE SET
				password_hash = excluded.password_hash,
				email_verified_at = excluded.email_verified_at,
				stable_user_id = COALESCE(users.stable_user_id, excluded.stable_user_id)`,
	)
		.bind(
			`user-${crypto.randomUUID().slice(0, 8)}`,
			email,
			passwordHash,
			emailVerifiedAt,
			stableUserId,
		)
		.run()
	return Number(result.meta.last_row_id)
}

function createFormRequest(
	data: Record<string, string>,
	headers: Record<string, string> = {},
) {
	return new Request('https://example.com/oauth/authorize', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			...headers,
		},
		body: new URLSearchParams(data),
	})
}

function getCookiePair(setCookie: string) {
	return setCookie.split(';', 1)[0] ?? setCookie
}

test('authorize info, denial, approval, and default scopes follow the OAuth workflow', async () => {
	const successResponse = await handleAuthorizeInfo(
		new Request(
			'https://example.com/oauth/authorize-info?response_type=code&client_id=client-123&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&scope=profile&state=demo',
		),
		createEnv(createHelpers()),
	)

	expect(successResponse.status).toBe(200)
	await expect(successResponse.json()).resolves.toEqual({
		ok: true,
		client: { id: baseClient.clientId, name: baseClient.clientName },
		scopes: baseAuthRequest.scope,
		emailVerified: null,
	})

	const authorizeHtmlResponse = await handleAuthorizeRequest(
		new Request(
			'https://example.com/oauth/authorize?response_type=code&client_id=client-123&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&scope=profile&state=demo',
		),
		createEnv(createHelpers()),
	)
	expect(authorizeHtmlResponse.status).toBe(200)
	expect(authorizeHtmlResponse.headers.get('Content-Type')).toContain(
		'text/html',
	)
	const authorizeHtml = await authorizeHtmlResponse.text()
	expect(authorizeHtml).toContain(baseClient.clientName ?? '')
	expect(authorizeHtml).not.toContain('Loading authorization details')
	expect(authorizeHtml).not.toContain('Checking your session')
	expect(authorizeHtml).toContain('"oauthAuthorize"')

	const mismatchResponse = await handleAuthorizeInfo(
		new Request(
			`https://example.com/oauth/authorize-info?response_type=code&client_id=client-123&redirect_uri=${encodeURIComponent('https://example.com/callback')}&error_description=${encodeURIComponent(invalidClientIdMismatchMessage)}`,
		),
		createEnv(
			createHelpers({
				parseAuthRequest: async () => {
					throw new Error(invalidClientIdMismatchMessage)
				},
			}),
		),
	)

	expect(mismatchResponse.status).toBe(400)
	await expect(mismatchResponse.json()).resolves.toEqual({
		ok: false,
		error: invalidClientIdMismatchMessage,
		allowClientReset: true,
	})
	const setCookie = mismatchResponse.headers.get('Set-Cookie') ?? ''
	expect(setCookie).toContain('kody_oauth_client_reset=')
	expect(setCookie).toContain('Path=/oauth')

	const denyResponse = await handleAuthorizeRequest(
		createFormRequest({ decision: 'deny' }),
		createEnv(createHelpers()),
	)

	expect(denyResponse.status).toBe(302)
	const location = denyResponse.headers.get('Location')
	expect(location).toBeTruthy()
	const redirectUrl = new URL(location as string)
	const expectedRedirect = new URL(baseAuthRequest.redirectUri)
	expect(redirectUrl.origin).toBe(expectedRedirect.origin)
	expect(redirectUrl.pathname).toBe(expectedRedirect.pathname)
	expect(redirectUrl.searchParams.get('error')).toBe('access_denied')
	expect(redirectUrl.searchParams.get('state')).toBe('demo')

	const missingPasswordResponse = await handleAuthorizeRequest(
		createFormRequest(
			{ decision: 'approve', email: 'user@example.com' },
			{ Accept: 'application/json' },
		),
		createEnv(createHelpers()),
	)

	expect(missingPasswordResponse.status).toBe(400)
	await expect(missingPasswordResponse.json()).resolves.toEqual({
		ok: false,
		error: 'Email and password are required.',
		code: 'invalid_request',
	})

	let capturedOptions: CompleteAuthorizationOptions | null = null
	const sessionHelpers = createHelpers({
		async completeAuthorization(options) {
			capturedOptions = options
			return { redirectTo: 'https://example.com/callback?code=session' }
		},
	})
	setAuthSessionSecret(cookieSecret)
	const cookie = await createAuthCookie(
		{
			stableUserId: await createStableUserIdFromEmail('user@example.com'),
			email: 'user@example.com',
			rememberMe: false,
		},
		false,
	)

	const sessionResponse = await handleAuthorizeRequest(
		createFormRequest(
			{ decision: 'approve' },
			{ Accept: 'application/json', Cookie: cookie },
		),
		createEnv(sessionHelpers, await createDatabase('password123')),
	)

	expect(sessionResponse.status).toBe(200)
	const sessionPayload = await sessionResponse.json()
	expect(sessionPayload).toEqual({
		ok: true,
		redirectTo: 'https://example.com/callback?code=session',
	})
	expect(capturedOptions).not.toBeNull()

	let resolveCapturedOptions:
		| ((value: CompleteAuthorizationOptions) => void)
		| undefined
	const capturedOptionsPromise = new Promise<CompleteAuthorizationOptions>(
		(resolve) => {
			resolveCapturedOptions = resolve
		},
	)

	const helpers = createHelpers({
		parseAuthRequest: async () => ({
			...baseAuthRequest,
			scope: [],
		}),
		async completeAuthorization(options) {
			resolveCapturedOptions?.(options)
			return { redirectTo: 'https://example.com/callback?code=ok' }
		},
	})
	const defaultScopeResponse = await handleAuthorizeRequest(
		createFormRequest({
			decision: 'approve',
			email: 'user@example.com',
			password: 'password123',
		}),
		createEnv(helpers, await createDatabase('password123')),
	)

	expect(defaultScopeResponse.status).toBe(302)
	expect(defaultScopeResponse.headers.get('Location')).toBe(
		'https://example.com/callback?code=ok',
	)
	const defaultScopeOptions = await capturedOptionsPromise
	expect(defaultScopeOptions.scope).toEqual(oauthScopes)
})

test('Claude-shaped authorize requests render and approve without throwing', async () => {
	const htmlResponse = await handleAuthorizeRequest(
		new Request(claudeAuthorizeUrl),
		createEnv(
			createHelpers({
				parseAuthRequest: async () => claudeAuthRequest,
				lookupClient: async () => claudeClient,
			}),
		),
	)

	expect(htmlResponse.status).toBe(200)
	expect(htmlResponse.headers.get('Content-Type')).toContain('text/html')
	const html = await htmlResponse.text()
	expect(html).toContain('Claude')
	expect(html).toContain('"oauthAuthorize"')

	let capturedOptions: CompleteAuthorizationOptions | null = null
	const helpers = createHelpers({
		parseAuthRequest: async () => claudeAuthRequest,
		lookupClient: async () => claudeClient,
		async completeAuthorization(options) {
			capturedOptions = options
			return {
				redirectTo:
					'https://claude.ai/api/mcp/auth_callback?code=demo&state=x5z9jORTCRNTmZ5_fiH7tdVWDVbiPujOHtUkyHzBvmc',
			}
		},
	})
	const postResponse = await handleAuthorizeRequest(
		new Request(claudeAuthorizeUrl, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams({
				decision: 'approve',
				email: 'user@example.com',
				password: 'password123',
			}),
		}),
		createEnv(helpers, await createDatabase('password123')),
	)

	expect(postResponse.status).toBe(200)
	await expect(postResponse.json()).resolves.toEqual({
		ok: true,
		redirectTo:
			'https://claude.ai/api/mcp/auth_callback?code=demo&state=x5z9jORTCRNTmZ5_fiH7tdVWDVbiPujOHtUkyHzBvmc',
	})
	expect(capturedOptions?.request.resource).toBe('https://heykody.dev/mcp')
	expect(capturedOptions?.request.scope).toEqual(['profile', 'email'])
})

test('Gemini-shaped authorize requests default resource to /mcp when omitted', async () => {
	let capturedOptions: CompleteAuthorizationOptions | null = null
	const helpers = createHelpers({
		// Return a fresh object each time so the defaulting mutation stays local.
		parseAuthRequest: async () => ({ ...geminiAuthRequestWithoutResource }),
		lookupClient: async () => geminiClient,
		async completeAuthorization(options) {
			capturedOptions = options
			return {
				redirectTo:
					'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-106664623666703652842-heykody_dev?code=demo&state=gemini-demo-state',
			}
		},
	})
	const postResponse = await handleAuthorizeRequest(
		new Request(geminiAuthorizeUrl, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams({
				decision: 'approve',
				email: 'user@example.com',
				password: 'password123',
			}),
		}),
		createEnv(helpers, await createDatabase('password123')),
	)

	expect(postResponse.status).toBe(200)
	await expect(postResponse.json()).resolves.toEqual({
		ok: true,
		redirectTo:
			'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-106664623666703652842-heykody_dev?code=demo&state=gemini-demo-state',
	})
	expect(capturedOptions?.request.resource).toBe('https://heykody.dev/mcp')
	expect(geminiAuthRequestWithoutResource.resource).toBeUndefined()
})

test('session approval uses stable user id when cookie email is stale', async () => {
	const currentEmail = `changed-oauth-${crypto.randomUUID()}@example.com`
	await seedWorkerUser(currentEmail, 'password123')
	let capturedOptions: CompleteAuthorizationOptions | null = null
	const helpers = createHelpers({
		async completeAuthorization(options) {
			capturedOptions = options
			return { redirectTo: 'https://example.com/callback?code=stale-session' }
		},
	})
	setAuthSessionSecret(cookieSecret)
	const cookie = await createAuthCookie(
		{
			stableUserId: await createStableUserIdFromEmail(currentEmail),
			email: `old-${currentEmail}`,
			rememberMe: false,
		},
		false,
	)

	const response = await handleAuthorizeRequest(
		createFormRequest(
			{ decision: 'approve' },
			{ Accept: 'application/json', Cookie: cookie },
		),
		createEnv(helpers, env.APP_DB),
	)

	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toEqual({
		ok: true,
		redirectTo: 'https://example.com/callback?code=stale-session',
	})
	expect(capturedOptions?.metadata).toMatchObject({ email: currentEmail })
	expect(capturedOptions?.props).toMatchObject({ email: currentEmail })
	const refreshedCookie = response.headers.get('Set-Cookie')
	expect(refreshedCookie).toContain('kody_session=')
	await expect(
		readAuthSessionResult(
			new Request('https://example.com', {
				headers: { Cookie: getCookiePair(refreshedCookie ?? '') },
			}),
		),
	).resolves.toMatchObject({
		session: {
			stableUserId: await createStableUserIdFromEmail(currentEmail),
			email: currentEmail,
		},
	})
})

test('authorize rejects unverified accounts before creating a grant', async () => {
	const completeAuthorization = vi.fn(async () => ({
		redirectTo: 'https://example.com/callback?code=should-not-happen',
	}))
	const helpers = createHelpers({ completeAuthorization })
	const unverifiedResponse = await handleAuthorizeRequest(
		createFormRequest(
			{
				decision: 'approve',
				email: 'user@example.com',
				password: 'password123',
			},
			{ Accept: 'application/json' },
		),
		createEnv(
			helpers,
			await createDatabase('password123', { emailVerifiedAt: null }),
		),
	)

	expect(unverifiedResponse.status).toBe(403)
	await expect(unverifiedResponse.json()).resolves.toEqual({
		ok: false,
		error: oauthEmailVerificationRequiredMessage,
		code: 'email_verification_required',
	})
	expect(completeAuthorization).not.toHaveBeenCalled()

	setAuthSessionSecret(cookieSecret)
	const cookie = await createAuthCookie(
		{
			stableUserId: await createStableUserIdFromEmail('user@example.com'),
			email: 'user@example.com',
			rememberMe: false,
		},
		false,
	)
	const sessionUnverifiedResponse = await handleAuthorizeRequest(
		createFormRequest(
			{ decision: 'approve' },
			{ Accept: 'application/json', Cookie: cookie },
		),
		createEnv(
			helpers,
			await createDatabase('password123', { emailVerifiedAt: null }),
		),
	)
	expect(sessionUnverifiedResponse.status).toBe(403)
	await expect(sessionUnverifiedResponse.json()).resolves.toMatchObject({
		ok: false,
		code: 'email_verification_required',
	})
	expect(completeAuthorization).not.toHaveBeenCalled()

	const authorizeInfo = await handleAuthorizeInfo(
		new Request(
			'https://example.com/oauth/authorize-info?response_type=code&client_id=client-123&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&scope=profile&state=demo',
			{
				headers: { Accept: 'application/json', Cookie: cookie },
			},
		),
		createEnv(
			helpers,
			await createDatabase('password123', { emailVerifiedAt: null }),
		),
	)
	expect(authorizeInfo.status).toBe(200)
	await expect(authorizeInfo.json()).resolves.toMatchObject({
		ok: true,
		emailVerified: false,
	})

	completeAuthorization.mockClear()
	completeAuthorization.mockImplementation(async () => ({
		redirectTo: 'https://example.com/callback?code=verified-ok',
	}))
	const verifiedResponse = await handleAuthorizeRequest(
		createFormRequest(
			{
				decision: 'approve',
				email: 'user@example.com',
				password: 'password123',
			},
			{ Accept: 'application/json' },
		),
		createEnv(helpers, await createDatabase('password123')),
	)
	expect(verifiedResponse.status).toBe(200)
	await expect(verifiedResponse.json()).resolves.toEqual({
		ok: true,
		redirectTo: 'https://example.com/callback?code=verified-ok',
	})
	expect(completeAuthorization).toHaveBeenCalledTimes(1)
})

test('worker entrypoint handles Claude-shaped authorize GET requests', async () => {
	await env.OAUTH_KV.put(
		`client:${claudeClient.clientId}`,
		JSON.stringify(claudeClient),
	)

	const response = await workerFetch(new Request(claudeAuthorizeUrl))

	expect(response.status).toBe(200)
	expect(response.headers.get('Content-Type')).toContain('text/html')
	const html = await response.text()
	expect(html).toContain('Claude')
	expect(html).toContain('"oauthAuthorize"')
})

test('worker entrypoint renders a recoverable error for missing Claude clients', async () => {
	await env.OAUTH_KV.delete(`client:${claudeClient.clientId}`)

	const response = await workerFetch(new Request(claudeAuthorizeUrl))

	expect(response.status).toBe(200)
	expect(response.headers.get('Content-Type')).toContain('text/html')
	const html = await response.text()
	expect(html).toContain('Invalid client')
	expect(html).toContain('"oauthAuthorize"')
})

test('worker entrypoint renders a recoverable error for malformed Claude clients', async () => {
	await env.OAUTH_KV.put(
		`client:${claudeClient.clientId}`,
		JSON.stringify({
			client_id: claudeClient.clientId,
			redirect_uris: [claudeAuthRequest.redirectUri],
			client_name: claudeClient.clientName,
			token_endpoint_auth_method: 'none',
		}),
	)

	const response = await workerFetch(new Request(claudeAuthorizeUrl))

	expect(response.status).toBe(200)
	expect(response.headers.get('Content-Type')).toContain('text/html')
	const html = await response.text()
	expect(html).toContain('Invalid OAuth client registration.')
	expect(html).toContain('"oauthAuthorize"')
})

test('worker entrypoint completes Claude-shaped dynamic registration and token exchange', async () => {
	const email = `claude-oauth-${crypto.randomUUID()}@example.com`
	const password = 'password123'
	await seedWorkerUser(email, password)

	const registerResponse = await workerFetch(
		new Request('https://heykody.dev/oauth/register', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				redirect_uris: [claudeAuthRequest.redirectUri],
				client_name: 'Claude',
				token_endpoint_auth_method: 'none',
				grant_types: ['authorization_code', 'refresh_token'],
				response_types: ['code'],
			}),
		}),
	)
	expect(registerResponse.status).toBe(201)
	const registeredClient = (await registerResponse.json()) as {
		client_id: string
	}
	const verifier = 'claude-verifier-0123456789'
	const authorizeUrl = new URL(claudeAuthorizeUrl)
	authorizeUrl.searchParams.set('client_id', registeredClient.client_id)
	authorizeUrl.searchParams.set(
		'code_challenge',
		await createS256CodeChallenge(verifier),
	)

	const authorizeResponse = await workerFetch(new Request(authorizeUrl))
	expect(authorizeResponse.status).toBe(200)
	expect(await authorizeResponse.text()).toContain('Claude')

	const approvalResponse = await workerFetch(
		new Request(authorizeUrl, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams({
				decision: 'approve',
				email,
				password,
			}),
		}),
	)
	expect(approvalResponse.status).toBe(200)
	const approvalPayload = (await approvalResponse.json()) as {
		redirectTo: string
	}
	const callbackUrl = new URL(approvalPayload.redirectTo)
	const code = callbackUrl.searchParams.get('code')
	expect(code).toBeTruthy()

	const tokenResponse = await workerFetch(
		new Request('https://heykody.dev/oauth/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				client_id: registeredClient.client_id,
				code: code ?? '',
				redirect_uri: claudeAuthRequest.redirectUri,
				code_verifier: verifier,
				resource: 'https://heykody.dev/mcp',
			}),
		}),
	)
	expect(tokenResponse.status).toBe(200)
	await expect(tokenResponse.json()).resolves.toMatchObject({
		token_type: 'bearer',
		resource: 'https://heykody.dev/mcp',
		scope: 'profile email',
	})
})

test('worker entrypoint advertises MCP resource metadata on both RFC 9728 paths', async () => {
	const expected = {
		resource: 'https://heykody.dev/mcp',
		authorization_servers: ['https://heykody.dev'],
		scopes_supported: oauthScopes,
		bearer_methods_supported: ['header'],
	}
	for (const path of [
		'/.well-known/oauth-protected-resource',
		'/.well-known/oauth-protected-resource/mcp',
	]) {
		const response = await workerFetch(
			new Request(`https://heykody.dev${path}`),
		)
		expect(response.status).toBe(200)
		await expect(response.json()).resolves.toEqual(expected)
	}

	const discovery = await workerFetch(
		new Request('https://heykody.dev/.well-known/oauth-authorization-server'),
	)
	expect(discovery.status).toBe(200)
	const metadata = (await discovery.json()) as {
		client_id_metadata_document_supported?: boolean
		code_challenge_methods_supported?: Array<string>
		token_endpoint_auth_methods_supported?: Array<string>
	}
	expect(metadata.client_id_metadata_document_supported).toBe(true)
	expect(metadata.code_challenge_methods_supported).toEqual(['S256'])
	expect(metadata.token_endpoint_auth_methods_supported).toContain('none')
	expect(metadata.token_endpoint_auth_methods_supported).not.toContain(
		'private_key_jwt',
	)
})

test('worker entrypoint completes ChatGPT-shaped CIMD authorize and token exchange', async () => {
	const email = `chatgpt-oauth-${crypto.randomUUID()}@example.com`
	const password = 'password123'
	await seedWorkerUser(email, password)

	const chatgptClientMetadataUrl =
		'https://chatgpt.com/oauth/vG3-MLZWUV83/client.json'
	const chatgptRedirectUri = 'https://chatgpt.com/connector/oauth/vG3-MLZWUV83'
	const chatgptClientDocument = {
		client_id: chatgptClientMetadataUrl,
		client_uri: 'https://chatgpt.com/',
		redirect_uris: [chatgptRedirectUri],
		token_endpoint_auth_method: 'private_key_jwt',
		token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
		grant_types: ['authorization_code', 'refresh_token'],
		response_types: ['code'],
		client_name: 'ChatGPT',
		logo_uri: 'https://persistent.oaistatic.com/sonic/misc/openai-logo.png',
		token_endpoint_auth_signing_alg: 'RS256',
		jwks_uri: 'https://chatgpt.com/oauth/jwks.json',
	}
	const originalFetch = globalThis.fetch
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input)
		if (url.split('?')[0] === chatgptClientMetadataUrl) {
			return new Response(JSON.stringify(chatgptClientDocument), {
				status: 200,
				headers: { 'Content-Type': 'application/json; charset=utf-8' },
			})
		}
		return originalFetch(input, init)
	}) as typeof fetch

	try {
		const verifier = 'chatgpt-verifier-0123456789'
		const authorizeUrl = new URL('https://heykody.dev/oauth/authorize')
		authorizeUrl.searchParams.set('response_type', 'code')
		authorizeUrl.searchParams.set('client_id', chatgptClientMetadataUrl)
		authorizeUrl.searchParams.set('redirect_uri', chatgptRedirectUri)
		authorizeUrl.searchParams.set('scope', 'profile email')
		authorizeUrl.searchParams.set(
			'code_challenge',
			await createS256CodeChallenge(verifier),
		)
		authorizeUrl.searchParams.set('code_challenge_method', 'S256')
		authorizeUrl.searchParams.set('resource', 'https://heykody.dev/mcp')
		authorizeUrl.searchParams.set('state', 'chatgpt-demo-state')

		const authorizeResponse = await workerFetch(new Request(authorizeUrl))
		expect(authorizeResponse.status).toBe(200)
		expect(await authorizeResponse.text()).toContain('ChatGPT')

		const approvalResponse = await workerFetch(
			new Request(authorizeUrl, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					decision: 'approve',
					email,
					password,
				}),
			}),
		)
		expect(approvalResponse.status).toBe(200)
		const approvalPayload = (await approvalResponse.json()) as {
			redirectTo: string
		}
		const callbackUrl = new URL(approvalPayload.redirectTo)
		const code = callbackUrl.searchParams.get('code')
		expect(code).toBeTruthy()
		expect(callbackUrl.searchParams.get('iss')).toBe('https://heykody.dev')

		const tokenResponse = await workerFetch(
			new Request('https://heykody.dev/oauth/token', {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					grant_type: 'authorization_code',
					client_id: chatgptClientMetadataUrl,
					code: code ?? '',
					redirect_uri: chatgptRedirectUri,
					code_verifier: verifier,
					resource: 'https://heykody.dev/mcp',
				}),
			}),
		)
		expect(tokenResponse.status).toBe(200)
		await expect(tokenResponse.json()).resolves.toMatchObject({
			token_type: 'bearer',
			resource: 'https://heykody.dev/mcp',
			scope: 'profile email',
		})
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('worker entrypoint treats a failed ChatGPT CIMD fetch as an unknown client', async () => {
	const chatgptClientMetadataUrl =
		'https://chatgpt.com/oauth/vG3-MLZWUV83/client.json'
	const originalFetch = globalThis.fetch
	consoleWarn.mockImplementation(() => {})
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input)
		if (url.split('?')[0] === chatgptClientMetadataUrl) {
			return new Response('upstream unavailable', { status: 503 })
		}
		return originalFetch(input, init)
	}) as typeof fetch

	try {
		const authorizeUrl = new URL('https://heykody.dev/oauth/authorize')
		authorizeUrl.searchParams.set('response_type', 'code')
		authorizeUrl.searchParams.set('client_id', chatgptClientMetadataUrl)
		authorizeUrl.searchParams.set(
			'redirect_uri',
			'https://chatgpt.com/connector/oauth/vG3-MLZWUV83',
		)
		authorizeUrl.searchParams.set('code_challenge', 'x'.repeat(43))
		authorizeUrl.searchParams.set('code_challenge_method', 'S256')
		authorizeUrl.searchParams.set('resource', 'https://heykody.dev/mcp')

		const authorizeInfoUrl = new URL('https://heykody.dev/oauth/authorize-info')
		authorizeInfoUrl.search = authorizeUrl.search
		const response = await workerFetch(new Request(authorizeInfoUrl))
		expect(response.status).toBe(400)
		await expect(response.json()).resolves.toMatchObject({
			ok: false,
			error: 'Unknown OAuth client.',
		})
		expect(consoleWarn.mock.calls.flat().join(' ')).toContain(
			'CIMD fetch failed',
		)
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('worker entrypoint returns OAuth errors for provider-owned route exceptions', async () => {
	const registerResponse = await workerFetch(
		new Request('https://heykody.dev/oauth/register', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: 'null',
		}),
	)
	expect(registerResponse.status).toBe(400)
	await expect(registerResponse.json()).resolves.toEqual({
		error: 'invalid_client_metadata',
		error_description: 'Client metadata must be a JSON object',
	})

	const clientId = `malformed-token-client-${crypto.randomUUID()}`
	const userId = `oauth-user-${crypto.randomUUID()}`
	const grantId = `oauth-grant-${crypto.randomUUID()}`
	const code = `${userId}:${grantId}:secret`
	const verifier = 'verifier'
	await env.OAUTH_KV.put(
		`client:${clientId}`,
		JSON.stringify({
			clientId,
			clientName: 'Claude',
			tokenEndpointAuthMethod: 'none',
		}),
	)
	await env.OAUTH_KV.put(
		`grant:${userId}:${grantId}`,
		JSON.stringify({
			id: grantId,
			clientId,
			userId,
			scope: ['profile', 'email'],
			metadata: {},
			encryptedProps: '',
			createdAt: Math.floor(Date.now() / 1000),
			authCodeId: await createSha256Hex(code),
			// 0.10+ treats a missing authCodeWrappedKey as an already-used code and
			// returns invalid_grant before redirect_uri validation. Keep a dummy
			// wrapped key so the malformed-client redirectUris TypeError still
			// reaches the worker exception mapper under test.
			authCodeWrappedKey: 'malformed-client-auth-code-wrapped-key',
			resource: 'https://heykody.dev/mcp',
			codeChallenge: await createS256CodeChallenge(verifier),
			codeChallengeMethod: 'S256',
		}),
	)

	const captureException = vi
		.spyOn(Sentry, 'captureException')
		.mockImplementation(() => undefined)
	const tokenResponse = await workerFetch(
		new Request('https://heykody.dev/oauth/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				client_id: clientId,
				code,
				redirect_uri: claudeAuthRequest.redirectUri,
				code_verifier: verifier,
				resource: 'https://heykody.dev/mcp',
			}),
		}),
	)
	expect(tokenResponse.status).toBe(401)
	await expect(tokenResponse.json()).resolves.toEqual({
		error: 'invalid_client',
		error_description: 'Invalid OAuth client registration.',
	})
	expect(captureException).toHaveBeenCalledOnce()
	captureException.mockRestore()
})

test('worker entrypoint renders OAuth errors for delegated authorize route exceptions', async () => {
	const response = await workerFetch(
		new Request(claudeAuthorizeUrl, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'multipart/form-data',
			},
			body: 'not a valid multipart body',
		}),
	)

	expect(response.status).toBe(500)
	expect(response.headers.get('Content-Type')).toContain('application/json')
	await expect(response.json()).resolves.toEqual({
		ok: false,
		error: 'OAuth authorization failed. Please start the connection again.',
		code: 'server_error',
	})
})

test('reset client revokes matching grants without deleting a shared DCR client', async () => {
	const userId = await createStableUserIdFromEmail('user@example.com')
	const appDb = await createDatabase('password123')
	setAuthSessionSecret(cookieSecret)
	const cookie = await createAuthCookie(
		{
			stableUserId: userId,
			email: 'user@example.com',
			rememberMe: false,
		},
		false,
	)

	const redirectUriRevokedGrantIds = new Array<string>()
	const redirectUriDeletedClientIds = new Array<string>()
	const redirectUriHelpers = createHelpers({
		parseAuthRequest: async () => {
			throw new Error(
				'Invalid redirect URI. The redirect URI provided does not match any registered URI for this client.',
			)
		},
		listUserGrants: async (requestedUserId) => {
			expect(requestedUserId).toBe(userId)
			return {
				items: [
					{
						id: 'grant-1',
						clientId: 'client-123',
						userId,
						scope: ['profile'],
						metadata: {},
						createdAt: 0,
					},
					{
						id: 'grant-2',
						clientId: 'other-client',
						userId,
						scope: ['profile'],
						metadata: {},
						createdAt: 0,
					},
					{
						id: 'grant-3',
						clientId: 'client-123',
						userId,
						scope: ['email'],
						metadata: {},
						createdAt: 0,
					},
				],
			}
		},
		revokeGrant: async (grantId, requestedUserId) => {
			expect(requestedUserId).toBe(userId)
			redirectUriRevokedGrantIds.push(grantId)
		},
		deleteClient: async (clientId) => {
			redirectUriDeletedClientIds.push(clientId)
		},
	})

	const redirectUriResponse = await handleAuthorizeRequest(
		new Request(
			`https://example.com/oauth/authorize?client_id=client-123&redirect_uri=${encodeURIComponent('https://example.com/invalid')}&error_description=${encodeURIComponent('Invalid redirect URI. The redirect URI provided does not match any registered URI for this client.')}`,
			{
				method: 'POST',
				headers: {
					Accept: 'application/json',
					Cookie: cookie,
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({ decision: 'reset-client' }),
			},
		),
		createEnv(redirectUriHelpers, appDb),
	)

	expect(redirectUriResponse.status).toBe(200)
	await expect(redirectUriResponse.json()).resolves.toMatchObject({
		ok: true,
		message: expect.stringMatching(/revoked this account/i),
	})
	expect(redirectUriRevokedGrantIds).toEqual(['grant-1', 'grant-3'])
	expect(redirectUriDeletedClientIds).toEqual([])

	const clientMismatchRevokedGrantIds = new Array<string>()
	const clientMismatchDeletedClientIds = new Array<string>()
	const clientMismatchHelpers = createHelpers({
		parseAuthRequest: async () => {
			throw new Error(invalidClientIdMismatchMessage)
		},
		listUserGrants: async (requestedUserId) => {
			expect(requestedUserId).toBe(userId)
			return {
				items: [
					{
						id: 'grant-1',
						clientId: 'client-123',
						userId,
						scope: ['profile'],
						metadata: {},
						createdAt: 0,
					},
					{
						id: 'grant-2',
						clientId: 'client-123',
						userId,
						scope: ['email'],
						metadata: {},
						createdAt: 0,
					},
				],
			}
		},
		revokeGrant: async (grantId, requestedUserId) => {
			expect(requestedUserId).toBe(userId)
			clientMismatchRevokedGrantIds.push(grantId)
		},
		deleteClient: async (clientId) => {
			clientMismatchDeletedClientIds.push(clientId)
		},
	})
	const authorizeInfoResponse = await handleAuthorizeInfo(
		new Request(
			`https://example.com/oauth/authorize-info?response_type=code&client_id=client-123&redirect_uri=${encodeURIComponent('https://example.com/callback')}&error_description=${encodeURIComponent(invalidClientIdMismatchMessage)}`,
		),
		createEnv(clientMismatchHelpers, appDb),
	)
	const resetVerificationCookie =
		authorizeInfoResponse.headers.get('Set-Cookie') ?? ''

	const clientMismatchResponse = await handleAuthorizeRequest(
		new Request(
			`https://example.com/oauth/authorize?client_id=client-123&redirect_uri=${encodeURIComponent('https://example.com/callback')}&error_description=${encodeURIComponent(invalidClientIdMismatchMessage)}`,
			{
				method: 'POST',
				headers: {
					Accept: 'application/json',
					Cookie: `${getCookiePair(cookie)}; ${getCookiePair(resetVerificationCookie)}`,
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({ decision: 'reset-client' }),
			},
		),
		createEnv(clientMismatchHelpers, appDb),
	)

	expect(clientMismatchResponse.status).toBe(200)
	await expect(clientMismatchResponse.json()).resolves.toMatchObject({
		ok: true,
		message: expect.stringMatching(/revoked this account/i),
	})
	expect(clientMismatchRevokedGrantIds).toEqual(['grant-1', 'grant-2'])
	expect(clientMismatchDeletedClientIds).toEqual([])

	const authorizeInfoRevokedGrantIds = new Array<string>()
	const authorizeInfoDeletedClientIds = new Array<string>()
	const authorizeInfoHelpers = createHelpers({
		listUserGrants: async (requestedUserId) => {
			expect(requestedUserId).toBe(userId)
			return {
				items: [
					{
						id: 'grant-1',
						clientId: 'client-123',
						userId,
						scope: ['profile'],
						metadata: {},
						createdAt: 0,
					},
				],
			}
		},
		revokeGrant: async (grantId) => {
			authorizeInfoRevokedGrantIds.push(grantId)
		},
		deleteClient: async (clientId) => {
			authorizeInfoDeletedClientIds.push(clientId)
		},
	})

	const authorizeInfoResetResponse = await handleAuthorizeRequest(
		new Request(
			'https://example.com/oauth/authorize?client_id=client-123&redirect_uri=https%3A%2F%2Flocalhost%3A8888%2Fcallback',
			{
				method: 'POST',
				headers: {
					Accept: 'application/json',
					Cookie: cookie,
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					decision: 'reset-client',
				}),
			},
		),
		createEnv(authorizeInfoHelpers, appDb),
	)

	expect(authorizeInfoResetResponse.status).toBe(200)
	await expect(authorizeInfoResetResponse.json()).resolves.toMatchObject({
		ok: true,
		message: expect.stringMatching(/revoked this account/i),
	})
	expect(authorizeInfoRevokedGrantIds).toEqual(['grant-1'])
	expect(authorizeInfoDeletedClientIds).toEqual([])
})

test("reset client deletes an owned MCP OAuth client after revoking this user's grants", async () => {
	const userId = await createStableUserIdFromEmail('user@example.com')
	const appDb = await createDatabase('password123', {
		ownedClientIds: ['client-123'],
	})
	setAuthSessionSecret(cookieSecret)
	const cookie = await createAuthCookie(
		{
			stableUserId: userId,
			email: 'user@example.com',
			rememberMe: false,
		},
		false,
	)
	const revokedGrantIds = new Array<string>()
	const deletedClientIds = new Array<string>()
	const helpers = createHelpers({
		parseAuthRequest: async () => {
			throw new Error(
				'Invalid redirect URI. The redirect URI provided does not match any registered URI for this client.',
			)
		},
		listUserGrants: async (requestedUserId) => {
			expect(requestedUserId).toBe(userId)
			return {
				items: [
					{
						id: 'grant-owned',
						clientId: 'client-123',
						userId,
						scope: ['profile'],
						metadata: {},
						createdAt: 0,
					},
				],
			}
		},
		revokeGrant: async (grantId, requestedUserId) => {
			expect(requestedUserId).toBe(userId)
			revokedGrantIds.push(grantId)
		},
		deleteClient: async (clientId) => {
			deletedClientIds.push(clientId)
		},
	})

	const response = await handleAuthorizeRequest(
		new Request(
			`https://example.com/oauth/authorize?client_id=client-123&redirect_uri=${encodeURIComponent('https://example.com/invalid')}&error_description=${encodeURIComponent('Invalid redirect URI. The redirect URI provided does not match any registered URI for this client.')}`,
			{
				method: 'POST',
				headers: {
					Accept: 'application/json',
					Cookie: cookie,
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({ decision: 'reset-client' }),
			},
		),
		createEnv(helpers, appDb),
	)

	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toMatchObject({
		ok: true,
		message: expect.stringMatching(/deleted your stored client registration/i),
	})
	expect(revokedGrantIds).toEqual(['grant-owned'])
	expect(deletedClientIds).toEqual(['client-123'])
})

test('reset client rejects requests without a stale or mismatched client registration', async () => {
	const env = createEnv(createHelpers())
	const postReset = (errorDescription: string) =>
		handleAuthorizeRequest(
			new Request(
				`https://example.com/oauth/authorize?client_id=client-123&redirect_uri=${encodeURIComponent('https://example.com/callback')}&error_description=${encodeURIComponent(errorDescription)}`,
				{
					method: 'POST',
					headers: {
						Accept: 'application/json',
						'Content-Type': 'application/x-www-form-urlencoded',
					},
					body: new URLSearchParams({ decision: 'reset-client' }),
				},
			),
			env,
		)

	const withoutVerificationCookie = await postReset(
		invalidClientIdMismatchMessage,
	)
	expect(withoutVerificationCookie.status).toBe(400)
	await expect(withoutVerificationCookie.json()).resolves.toEqual({
		ok: false,
		error:
			'Stored client cleanup is only available for stale or mismatched client registrations.',
		code: 'invalid_request',
	})

	const unrelatedAuthorizationError = await postReset('Authorization error')
	expect(unrelatedAuthorizationError.status).toBe(400)
	await expect(unrelatedAuthorizationError.json()).resolves.toEqual({
		ok: false,
		error:
			'Stored client cleanup is only available for stale or mismatched client registrations.',
		code: 'invalid_request',
	})
})
