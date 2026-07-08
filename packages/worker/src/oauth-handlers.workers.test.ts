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
		...overrides,
	}
}

async function createDatabase(password: string) {
	const passwordHash = await createPasswordHash(password)
	return {
		prepare(query: string) {
			// The 2FA gate queries verifications during inline OAuth login; the
			// mocked user has no verification rows, so those queries are empty.
			const isVerificationsQuery = query.includes('FROM verifications')
			return {
				bind() {
					return {
						async all() {
							return {
								results: isVerificationsQuery
									? []
									: [
											{
												id: 1,
												username: 'test-user',
												email: 'user@example.com',
												password_hash: passwordHash,
											},
										],
								meta: { changes: 0, last_row_id: 0 },
							}
						},
						async first() {
							if (isVerificationsQuery) return null
							return {
								id: 1,
								username: 'test-user',
								email: 'user@example.com',
								password_hash: passwordHash,
							}
						},
						async run() {
							return { meta: { changes: 1, last_row_id: 1 } }
						},
					}
				},
			}
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
		PACKAGE_SERVICE_INSTANCE: mockJobDoNamespace(
			'package-service-instance-test-id',
		),
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

async function seedWorkerUser(email: string, password: string) {
	const passwordHash = await createPasswordHash(password)
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS users (
			id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
			username TEXT NOT NULL UNIQUE,
			email TEXT NOT NULL UNIQUE,
			password_hash TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
			updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		)`,
	).run()
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
	const result = await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash)
			VALUES (?, ?, ?)
			ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash`,
	)
		.bind(`user-${crypto.randomUUID().slice(0, 8)}`, email, passwordHash)
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
		{ id: 'session-id', email: 'user@example.com', rememberMe: false },
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

test('session approval uses database user id when cookie email is stale', async () => {
	const currentEmail = `changed-oauth-${crypto.randomUUID()}@example.com`
	const userId = await seedWorkerUser(currentEmail, 'password123')
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
			id: String(userId),
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
		session: { id: String(userId), email: currentEmail },
	})
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
		error: 'invalid_request',
		error_description: 'Invalid OAuth client registration.',
	})

	const clientId = `malformed-token-client-${crypto.randomUUID()}`
	const userId = `oauth-user-${crypto.randomUUID()}`
	const grantId = `oauth-grant-${crypto.randomUUID()}`
	const code = `${userId}:${grantId}:secret`
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
			resource: 'https://heykody.dev/mcp',
			codeChallenge: 'verifier',
			codeChallengeMethod: 'plain',
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
				code_verifier: 'verifier',
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

test('reset client deletes matching grants for redirect-uri, client-id, and authorize-info mismatches', async () => {
	const userId = await createStableUserIdFromEmail('user@example.com')
	setAuthSessionSecret(cookieSecret)
	const cookie = await createAuthCookie(
		{ id: 'session-id', email: 'user@example.com', rememberMe: false },
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
		createEnv(redirectUriHelpers),
	)

	expect(redirectUriResponse.status).toBe(200)
	await expect(redirectUriResponse.json()).resolves.toMatchObject({
		ok: true,
		message: expect.stringMatching(/deleted the stored client records/i),
	})
	expect(redirectUriRevokedGrantIds).toEqual(['grant-1', 'grant-3'])
	expect(redirectUriDeletedClientIds).toEqual(['client-123'])

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
		createEnv(clientMismatchHelpers),
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
		createEnv(clientMismatchHelpers),
	)

	expect(clientMismatchResponse.status).toBe(200)
	await expect(clientMismatchResponse.json()).resolves.toMatchObject({
		ok: true,
		message: expect.stringMatching(/deleted the stored client records/i),
	})
	expect(clientMismatchRevokedGrantIds).toEqual(['grant-1', 'grant-2'])
	expect(clientMismatchDeletedClientIds).toEqual(['client-123'])

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
		createEnv(authorizeInfoHelpers),
	)

	expect(authorizeInfoResetResponse.status).toBe(200)
	await expect(authorizeInfoResetResponse.json()).resolves.toMatchObject({
		ok: true,
		message: expect.stringMatching(/deleted the stored client records/i),
	})
	expect(authorizeInfoRevokedGrantIds).toEqual(['grant-1'])
	expect(authorizeInfoDeletedClientIds).toEqual(['client-123'])
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
