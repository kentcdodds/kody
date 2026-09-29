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
import { honeypotFieldName } from '#universal/public-form-protection.ts'
import { oauthAuthorizeClobberedResubmitMessage } from './oauth-authorize-clobber.ts'
import {
	handleAuthorizeInfo,
	handleAuthorizeRequest,
	oauthEmailVerificationRequiredMessage,
	oauthScopes,
} from './oauth-handlers.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import { seedAccount } from '#worker/test-support/workers-seed.ts'
import {
	TEST_OIDC_SIGNING_KEY_ID,
	TEST_OIDC_SIGNING_PRIVATE_KEY_PEM,
} from '#worker/oidc/test-signing-key.ts'

const callbackUri = 'https://example.com/callback'
const mcpResource = 'https://heykody.dev/mcp'
const baseAuthRequest: AuthRequest = {
	responseType: 'code',
	clientId: 'client-123',
	redirectUri: callbackUri,
	scope: ['profile'],
	state: 'demo',
}
const baseClient: ClientInfo = {
	clientId: 'client-123',
	redirectUris: [callbackUri],
	clientName: 'kody Demo',
	tokenEndpointAuthMethod: 'client_secret_basic',
}
const baseAuthorizeParams = {
	response_type: 'code',
	client_id: 'client-123',
	redirect_uri: callbackUri,
	scope: 'profile',
	state: 'demo',
}
const redirectUriMismatchMessage =
	'Invalid redirect URI. The redirect URI provided does not match any registered URI for this client.'
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
	resource: mcpResource,
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
const jsonAccept = { Accept: 'application/json' }
const approveWithPassword = {
	decision: 'approve',
	email: 'user@example.com',
	password: 'password123',
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

function completingWith(redirectTo: string) {
	return vi.fn(async (_options: CompleteAuthorizationOptions) => ({
		redirectTo,
	}))
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

function createEnv(helpers: OAuthHelpers, appDb?: D1Database) {
	return {
		OAUTH_PROVIDER: helpers,
		APP_DB: appDb ?? ({} as D1Database),
		BUNDLE_ARTIFACTS_KV: {
			get: async () => null,
			put: async () => undefined,
			delete: async () => undefined,
		},
		COOKIE_SECRET: cookieSecret,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		// Audit writes are console-only under the test environment; without this
		// the handler warns about the missing AUDIT_DB binding on every call.
		SENTRY_ENVIRONMENT: 'test',
		OIDC_SIGNING_KEY_ID: TEST_OIDC_SIGNING_KEY_ID,
		OIDC_SIGNING_PRIVATE_KEY_PEM: TEST_OIDC_SIGNING_PRIVATE_KEY_PEM,
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

async function seedWorkerUser(email: string) {
	await ensureUsersTestSchema({
		db: env.APP_DB,
		columns: ['email_verified_at'],
	})
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
	await seedAccount({
		db: env.APP_DB,
		email,
		username: `user-${crypto.randomUUID().slice(0, 8)}`,
		passwordHash: await createPasswordHash('password123'),
	})
}

function exampleOAuthUrl(
	path: 'authorize' | 'authorize-info',
	params: Record<string, string>,
	origin = 'https://example.com',
) {
	return `${origin}/oauth/${path}?${new URLSearchParams(params)}`
}

function formRequest(
	data: Record<string, string>,
	headers: Record<string, string> = {},
	url: string | URL = 'https://example.com/oauth/authorize',
) {
	return new Request(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			...headers,
		},
		body: new URLSearchParams(data),
	})
}

async function sessionCookie(
	email = 'user@example.com',
	stableUserEmail = email,
) {
	setAuthSessionSecret(cookieSecret)
	return createAuthCookie(
		{
			stableUserId: await createStableUserIdFromEmail(stableUserEmail),
			email,
			rememberMe: false,
		},
		false,
	)
}

function getCookiePair(setCookie: string) {
	return setCookie.split(';', 1)[0] ?? setCookie
}

function expectRedirect(
	redirectTo: string,
	originPath: string,
	params: Record<string, string>,
	iss = 'https://example.com',
) {
	const redirectUrl = new URL(redirectTo)
	expect(redirectUrl.origin + redirectUrl.pathname).toBe(originPath)
	for (const [key, value] of Object.entries(params)) {
		expect(redirectUrl.searchParams.get(key)).toBe(value)
	}
	expect(redirectUrl.searchParams.get('iss')).toBe(iss)
}

async function expectApprovedRedirect(
	response: Response,
	originPath: string,
	params: Record<string, string>,
	iss?: string,
) {
	expect(response.status).toBe(200)
	const payload = (await response.json()) as { ok: boolean; redirectTo: string }
	expect(payload.ok).toBe(true)
	expectRedirect(payload.redirectTo, originPath, params, iss)
}

async function readAuthorizePage(response: Response) {
	expect(response.status).toBe(200)
	expect(response.headers.get('Content-Type')).toContain('text/html')
	const html = await response.text()
	expect(html).toContain('"oauthAuthorize"')
	return html
}

async function registerClient(metadata: Record<string, unknown>) {
	const response = await workerFetch(
		new Request('https://heykody.dev/oauth/register', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(metadata),
		}),
	)
	expect(response.status).toBe(201)
	return ((await response.json()) as { client_id: string }).client_id
}

async function heykodyAuthorizeUrl(
	params: Record<string, string>,
	verifier: string,
) {
	const url = new URL('https://heykody.dev/oauth/authorize')
	url.search = new URLSearchParams({
		response_type: 'code',
		...params,
		code_challenge: await createS256CodeChallenge(verifier),
		code_challenge_method: 'S256',
		resource: mcpResource,
	}).toString()
	return url
}

async function workerApprove(authorizeUrl: URL, email: string) {
	const response = await workerFetch(
		formRequest(
			{ decision: 'approve', email, password: 'password123' },
			jsonAccept,
			authorizeUrl,
		),
	)
	expect(response.status).toBe(200)
	const { redirectTo } = (await response.json()) as { redirectTo: string }
	const callbackUrl = new URL(redirectTo)
	const code = callbackUrl.searchParams.get('code')
	expect(code).toBeTruthy()
	return { callbackUrl, code: code ?? '' }
}

function exchangeCode(
	params: {
		client_id: string
		code: string
		redirect_uri: string
		code_verifier: string
	},
	workerEnv?: Env,
) {
	return workerFetch(
		formRequest(
			{ grant_type: 'authorization_code', ...params, resource: mcpResource },
			{},
			'https://heykody.dev/oauth/token',
		),
		workerEnv,
	)
}

function stubClientMetadataFetch(metadataUrl: string, respond: () => Response) {
	const originalFetch = globalThis.fetch
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input)
		return url.split('?')[0] === metadataUrl
			? respond()
			: originalFetch(input, init)
	}) as typeof fetch
	return {
		[Symbol.dispose]: () => {
			globalThis.fetch = originalFetch
		},
	}
}

function jsonResponse(body: unknown) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'Content-Type': 'application/json; charset=utf-8' },
	})
}

test('authorize info, denial, approval, and default scopes follow the OAuth workflow', async () => {
	const successResponse = await handleAuthorizeInfo(
		new Request(exampleOAuthUrl('authorize-info', baseAuthorizeParams)),
		createEnv(createHelpers()),
	)
	expect(successResponse.status).toBe(200)
	await expect(successResponse.json()).resolves.toEqual({
		ok: true,
		client: { id: baseClient.clientId, name: baseClient.clientName },
		scopes: baseAuthRequest.scope,
		emailVerified: null,
		requireCredentials: true,
	})

	const authorizeHtml = await readAuthorizePage(
		await handleAuthorizeRequest(
			new Request(exampleOAuthUrl('authorize', baseAuthorizeParams)),
			createEnv(createHelpers()),
		),
	)
	expect(authorizeHtml).toContain(baseClient.clientName ?? '')
	expect(authorizeHtml).not.toContain('Loading authorization details')

	const mismatchResponse = await handleAuthorizeInfo(
		new Request(
			exampleOAuthUrl('authorize-info', {
				response_type: 'code',
				client_id: 'client-123',
				redirect_uri: callbackUri,
				error_description: invalidClientIdMismatchMessage,
			}),
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
		formRequest({ decision: 'deny' }),
		createEnv(createHelpers()),
	)
	expect(denyResponse.status).toBe(302)
	const location = denyResponse.headers.get('Location')
	expect(location).toBeTruthy()
	expectRedirect(location ?? '', callbackUri, {
		error: 'access_denied',
		state: 'demo',
	})

	const missingPasswordResponse = await handleAuthorizeRequest(
		formRequest({ decision: 'approve', email: 'user@example.com' }, jsonAccept),
		createEnv(createHelpers()),
	)
	expect(missingPasswordResponse.status).toBe(400)
	await expect(missingPasswordResponse.json()).resolves.toEqual({
		ok: false,
		error: 'Email and password are required.',
		code: 'invalid_request',
	})

	const sessionCompletion = completingWith(
		'https://example.com/callback?code=session',
	)
	const sessionResponse = await handleAuthorizeRequest(
		formRequest(
			{ decision: 'approve' },
			{ ...jsonAccept, Cookie: await sessionCookie() },
		),
		createEnv(
			createHelpers({ completeAuthorization: sessionCompletion }),
			await createDatabase('password123'),
		),
	)
	await expectApprovedRedirect(sessionResponse, callbackUri, {
		code: 'session',
	})
	expect(sessionCompletion.mock.lastCall?.[0].request.issuer).toBe(
		'https://example.com',
	)

	const defaultScopeCompletion = completingWith(
		'https://example.com/callback?code=ok',
	)
	const defaultScopeResponse = await handleAuthorizeRequest(
		formRequest(approveWithPassword),
		createEnv(
			createHelpers({
				parseAuthRequest: async () => ({ ...baseAuthRequest, scope: [] }),
				completeAuthorization: defaultScopeCompletion,
			}),
			await createDatabase('password123'),
		),
	)
	expect(defaultScopeResponse.status).toBe(302)
	expectRedirect(
		defaultScopeResponse.headers.get('Location') ?? '',
		callbackUri,
		{
			code: 'ok',
		},
	)
	const defaultScopeOptions = defaultScopeCompletion.mock.lastCall?.[0]
	expect(defaultScopeOptions?.scope).toEqual(oauthScopes)
	expect(defaultScopeOptions?.request.issuer).toBe('https://example.com')
})

test('Gemini-shaped authorize requests default resource to /mcp when omitted', async () => {
	const completion = completingWith(
		`${geminiAuthRequestWithoutResource.redirectUri}?code=demo&state=gemini-demo-state`,
	)
	const helpers = createHelpers({
		// Return a fresh object each time so the defaulting mutation stays local.
		parseAuthRequest: async () => ({ ...geminiAuthRequestWithoutResource }),
		lookupClient: async () => geminiClient,
		completeAuthorization: completion,
	})
	const postResponse = await handleAuthorizeRequest(
		formRequest(approveWithPassword, jsonAccept, geminiAuthorizeUrl),
		createEnv(helpers, await createDatabase('password123')),
	)
	await expectApprovedRedirect(
		postResponse,
		geminiAuthRequestWithoutResource.redirectUri,
		{ code: 'demo', state: 'gemini-demo-state' },
		'https://heykody.dev',
	)
	expect(completion.mock.lastCall?.[0].request.resource).toBe(mcpResource)
	expect(geminiAuthRequestWithoutResource.resource).toBeUndefined()
})

test('session approval uses stable user id when cookie email is stale', async () => {
	const currentEmail = `changed-oauth-${crypto.randomUUID()}@example.com`
	await seedWorkerUser(currentEmail)
	const completion = completingWith(
		'https://example.com/callback?code=stale-session',
	)
	const cookie = await sessionCookie(`old-${currentEmail}`, currentEmail)

	const response = await handleAuthorizeRequest(
		formRequest({ decision: 'approve' }, { ...jsonAccept, Cookie: cookie }),
		createEnv(createHelpers({ completeAuthorization: completion }), env.APP_DB),
	)

	const refreshedCookie = response.headers.get('Set-Cookie')
	await expectApprovedRedirect(response, callbackUri, {
		code: 'stale-session',
	})
	expect(completion.mock.lastCall?.[0].metadata).toMatchObject({
		email: currentEmail,
	})
	expect(completion.mock.lastCall?.[0].props).toMatchObject({
		email: currentEmail,
	})
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
	const completeAuthorization = completingWith(
		'https://example.com/callback?code=should-not-happen',
	)
	const helpers = createHelpers({ completeAuthorization })
	const unverifiedEnv = async () =>
		createEnv(
			helpers,
			await createDatabase('password123', { emailVerifiedAt: null }),
		)

	const unverifiedResponse = await handleAuthorizeRequest(
		formRequest(approveWithPassword, jsonAccept),
		await unverifiedEnv(),
	)
	expect(unverifiedResponse.status).toBe(403)
	await expect(unverifiedResponse.json()).resolves.toEqual({
		ok: false,
		error: oauthEmailVerificationRequiredMessage,
		code: 'email_verification_required',
	})
	expect(completeAuthorization).not.toHaveBeenCalled()

	const cookie = await sessionCookie()
	const sessionUnverifiedResponse = await handleAuthorizeRequest(
		formRequest({ decision: 'approve' }, { ...jsonAccept, Cookie: cookie }),
		await unverifiedEnv(),
	)
	expect(sessionUnverifiedResponse.status).toBe(403)
	await expect(sessionUnverifiedResponse.json()).resolves.toMatchObject({
		ok: false,
		code: 'email_verification_required',
	})
	expect(completeAuthorization).not.toHaveBeenCalled()

	const authorizeInfo = await handleAuthorizeInfo(
		new Request(exampleOAuthUrl('authorize-info', baseAuthorizeParams), {
			headers: { ...jsonAccept, Cookie: cookie },
		}),
		await unverifiedEnv(),
	)
	expect(authorizeInfo.status).toBe(200)
	await expect(authorizeInfo.json()).resolves.toMatchObject({
		ok: true,
		emailVerified: false,
	})

	completeAuthorization.mockImplementation(async () => ({
		redirectTo: 'https://example.com/callback?code=verified-ok',
	}))
	const verifiedResponse = await handleAuthorizeRequest(
		formRequest(approveWithPassword, jsonAccept),
		createEnv(helpers, await createDatabase('password123')),
	)
	await expectApprovedRedirect(verifiedResponse, callbackUri, {
		code: 'verified-ok',
	})
	expect(completeAuthorization).toHaveBeenCalledTimes(1)
})

test('worker entrypoint renders Claude-shaped authorize GET and recoverable errors for missing or malformed clients', async () => {
	const clientKey = `client:${claudeClient.clientId}`
	const snakeCaseClient = {
		client_id: claudeClient.clientId,
		redirect_uris: [claudeAuthRequest.redirectUri],
		client_name: claudeClient.clientName,
		token_endpoint_auth_method: 'none',
	}
	for (const [storedClient, text] of [
		[claudeClient, 'Claude'],
		[snakeCaseClient, 'Invalid OAuth client registration.'],
		[null, 'Invalid client'],
	] as const) {
		if (storedClient) {
			await env.OAUTH_KV.put(clientKey, JSON.stringify(storedClient))
		} else {
			await env.OAUTH_KV.delete(clientKey)
		}
		expect(
			await readAuthorizePage(
				await workerFetch(new Request(claudeAuthorizeUrl)),
			),
		).toContain(text)
	}
})

test('worker entrypoint completes Claude-shaped dynamic registration and token exchange', async () => {
	const email = `claude-oauth-${crypto.randomUUID()}@example.com`
	await seedWorkerUser(email)
	const clientId = await registerClient({
		redirect_uris: [claudeAuthRequest.redirectUri],
		client_name: 'Claude',
		token_endpoint_auth_method: 'none',
		grant_types: ['authorization_code', 'refresh_token'],
		response_types: ['code'],
	})
	const verifier = 'claude-verifier-0123456789'
	const authorizeUrl = new URL(claudeAuthorizeUrl)
	authorizeUrl.searchParams.set('client_id', clientId)
	authorizeUrl.searchParams.set(
		'code_challenge',
		await createS256CodeChallenge(verifier),
	)

	const authorizeResponse = await workerFetch(new Request(authorizeUrl))
	expect(authorizeResponse.status).toBe(200)
	expect(await authorizeResponse.text()).toContain('Claude')

	const { code } = await workerApprove(authorizeUrl, email)
	const tokenResponse = await exchangeCode({
		client_id: clientId,
		code,
		redirect_uri: claudeAuthRequest.redirectUri,
		code_verifier: verifier,
	})
	expect(tokenResponse.status).toBe(200)
	await expect(tokenResponse.json()).resolves.toMatchObject({
		token_type: 'bearer',
		resource: mcpResource,
		scope: 'profile email',
	})
})

test('worker entrypoint advertises OAuth, OIDC, and RFC 9728 resource metadata plus jwks', async () => {
	for (const path of [
		'/.well-known/oauth-protected-resource',
		'/.well-known/oauth-protected-resource/mcp',
	]) {
		const response = await workerFetch(
			new Request(`https://heykody.dev${path}`),
		)
		expect(response.status).toBe(200)
		await expect(response.json()).resolves.toEqual({
			resource: mcpResource,
			authorization_servers: ['https://heykody.dev'],
			scopes_supported: oauthScopes,
			bearer_methods_supported: ['header'],
		})
	}

	const discovery = await workerFetch(
		new Request('https://heykody.dev/.well-known/oauth-authorization-server'),
	)
	expect(discovery.status).toBe(200)
	const metadata = (await discovery.json()) as {
		issuer?: string
		token_endpoint?: string
		revocation_endpoint?: string
		authorization_response_iss_parameter_supported?: boolean
		client_id_metadata_document_supported?: boolean
		code_challenge_methods_supported?: Array<string>
		token_endpoint_auth_methods_supported?: Array<string>
	}
	expect(metadata.issuer).toBe('https://heykody.dev')
	expect(metadata.token_endpoint).toBe('https://heykody.dev/oauth/token')
	expect(metadata.revocation_endpoint).toBe(metadata.token_endpoint)
	expect(metadata.authorization_response_iss_parameter_supported).toBe(true)
	expect(metadata.client_id_metadata_document_supported).toBe(true)
	expect(metadata.code_challenge_methods_supported).toEqual(['S256'])
	expect(metadata.token_endpoint_auth_methods_supported).toContain('none')
	expect(metadata.token_endpoint_auth_methods_supported).not.toContain(
		'private_key_jwt',
	)

	const oidcDiscovery = await workerFetch(
		new Request('https://heykody.dev/.well-known/openid-configuration'),
	)
	expect(oidcDiscovery.status).toBe(200)
	await expect(oidcDiscovery.json()).resolves.toMatchObject({
		issuer: metadata.issuer,
		token_endpoint: metadata.token_endpoint,
		revocation_endpoint: metadata.revocation_endpoint,
	})

	const jwks = await workerFetch(
		new Request('https://heykody.dev/.well-known/jwks.json'),
	)
	expect(jwks.status).toBe(200)
	const jwksBody = (await jwks.json()) as { keys: Array<{ kid: string }> }
	expect(jwksBody.keys[0]?.kid).toBeTruthy()
})

test('worker entrypoint completes ChatGPT-shaped CIMD authorize and token exchange', async () => {
	const email = `chatgpt-oauth-${crypto.randomUUID()}@example.com`
	await seedWorkerUser(email)
	const clientId = 'https://chatgpt.com/oauth/vG3-MLZWUV83/client.json'
	const redirectUri = 'https://chatgpt.com/connector/oauth/vG3-MLZWUV83'
	using _fetch = stubClientMetadataFetch(clientId, () =>
		jsonResponse({
			client_id: clientId,
			client_uri: 'https://chatgpt.com/',
			redirect_uris: [redirectUri],
			token_endpoint_auth_method: 'private_key_jwt',
			token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			client_name: 'ChatGPT',
			logo_uri: 'https://persistent.oaistatic.com/sonic/misc/openai-logo.png',
			token_endpoint_auth_signing_alg: 'RS256',
			jwks_uri: 'https://chatgpt.com/oauth/jwks.json',
		}),
	)
	const verifier = 'chatgpt-verifier-0123456789'
	const authorizeUrl = await heykodyAuthorizeUrl(
		{
			client_id: clientId,
			redirect_uri: redirectUri,
			scope: 'profile email',
			state: 'chatgpt-demo-state',
		},
		verifier,
	)

	const authorizeResponse = await workerFetch(new Request(authorizeUrl))
	expect(authorizeResponse.status).toBe(200)
	expect(await authorizeResponse.text()).toContain('ChatGPT')

	const { callbackUrl, code } = await workerApprove(authorizeUrl, email)
	expect(callbackUrl.searchParams.get('iss')).toBe('https://heykody.dev')

	const tokenResponse = await exchangeCode({
		client_id: clientId,
		code,
		redirect_uri: redirectUri,
		code_verifier: verifier,
	})
	expect(tokenResponse.status).toBe(200)
	await expect(tokenResponse.json()).resolves.toMatchObject({
		token_type: 'bearer',
		resource: mcpResource,
		scope: 'profile email',
	})
})

test('worker entrypoint treats a failed ChatGPT CIMD fetch as an unknown client', async () => {
	const clientId = 'https://chatgpt.com/oauth/vG3-MLZWUV83/client.json'
	consoleWarn.mockImplementation(() => {})
	using _fetch = stubClientMetadataFetch(
		clientId,
		() => new Response('upstream unavailable', { status: 503 }),
	)
	const authorizeUrl = await heykodyAuthorizeUrl(
		{
			client_id: clientId,
			redirect_uri: 'https://chatgpt.com/connector/oauth/vG3-MLZWUV83',
		},
		'chatgpt-verifier-0123456789',
	)
	const authorizeInfoUrl = new URL('https://heykody.dev/oauth/authorize-info')
	authorizeInfoUrl.search = authorizeUrl.search
	const captureException = vi
		.spyOn(Sentry, 'captureException')
		.mockImplementation(() => '')

	const response = await workerFetch(new Request(authorizeInfoUrl))
	expect(response.status).toBe(400)
	await expect(response.json()).resolves.toMatchObject({
		ok: false,
		error: 'Unknown OAuth client.',
	})
	expect(consoleWarn.mock.calls.flat().join(' ')).toContain('CIMD fetch failed')
	expect(captureException).not.toHaveBeenCalled()
	captureException.mockRestore()
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
			resource: mcpResource,
			codeChallenge: await createS256CodeChallenge(verifier),
			codeChallengeMethod: 'S256',
		}),
	)

	const captureException = vi
		.spyOn(Sentry, 'captureException')
		.mockImplementation(() => '')
	const tokenResponse = await exchangeCode({
		client_id: clientId,
		code,
		redirect_uri: claudeAuthRequest.redirectUri,
		code_verifier: verifier,
	})
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
			headers: { ...jsonAccept, 'Content-Type': 'multipart/form-data' },
			body: 'not a valid multipart body',
		}),
	)

	expect(response.status).toBe(400)
	expect(response.headers.get('Content-Type')).toContain('application/json')
	await expect(response.json()).resolves.toEqual({
		ok: false,
		error: 'Invalid form data',
		code: 'invalid_request',
	})
})

function resetClientHelpers(
	userId: string,
	grants: Array<[id: string, clientId: string, scope: string]>,
	parseError?: string,
) {
	const revoked = new Array<string>()
	const deleted = new Array<string>()
	const helpers = createHelpers({
		...(parseError
			? {
					parseAuthRequest: async () => {
						throw new Error(parseError)
					},
				}
			: {}),
		listUserGrants: async (requestedUserId) => {
			expect(requestedUserId).toBe(userId)
			return {
				items: grants.map(([id, clientId, scope]) => ({
					id,
					clientId,
					userId,
					scope: [scope],
					metadata: {},
					createdAt: 0,
				})),
			}
		},
		revokeGrant: async (grantId, requestedUserId) => {
			expect(requestedUserId).toBe(userId)
			revoked.push(grantId)
		},
		deleteClient: async (clientId) => {
			deleted.push(clientId)
		},
	})
	return { helpers, revoked, deleted }
}

function postResetClient(url: string, workerEnv: Env, cookie?: string) {
	return handleAuthorizeRequest(
		formRequest(
			{ decision: 'reset-client' },
			cookie ? { ...jsonAccept, Cookie: cookie } : jsonAccept,
			url,
		),
		workerEnv,
	)
}

async function resetClient(
	url: string,
	scenario: ReturnType<typeof resetClientHelpers>,
	appDb: D1Database,
	cookie: string,
) {
	const response = await postResetClient(
		url,
		createEnv(scenario.helpers, appDb),
		cookie,
	)
	return {
		status: response.status,
		body: await response.json(),
		revoked: scenario.revoked,
		deleted: scenario.deleted,
	}
}

function resetSucceeded(
	message: RegExp,
	revoked: Array<string>,
	deleted: Array<string> = [],
) {
	return {
		status: 200,
		body: expect.objectContaining({
			ok: true,
			message: expect.stringMatching(message),
		}),
		revoked,
		deleted,
	}
}

test("reset client revokes only this user's matching grants and deletes only owned client registrations", async () => {
	const userId = await createStableUserIdFromEmail('user@example.com')
	const sharedClientDb = await createDatabase('password123')
	const cookie = await sessionCookie()
	const invalidRedirectUrl = exampleOAuthUrl('authorize', {
		client_id: 'client-123',
		redirect_uri: 'https://example.com/invalid',
		error_description: redirectUriMismatchMessage,
	})
	const revokedAccount = /revoked this account/i

	const redirectUri = resetClientHelpers(
		userId,
		[
			['grant-1', 'client-123', 'profile'],
			['grant-2', 'other-client', 'profile'],
			['grant-3', 'client-123', 'email'],
		],
		redirectUriMismatchMessage,
	)
	expect(
		await resetClient(invalidRedirectUrl, redirectUri, sharedClientDb, cookie),
	).toEqual(resetSucceeded(revokedAccount, ['grant-1', 'grant-3']))

	const clientMismatch = resetClientHelpers(
		userId,
		[
			['grant-1', 'client-123', 'profile'],
			['grant-2', 'client-123', 'email'],
		],
		invalidClientIdMismatchMessage,
	)
	const mismatchParams = {
		client_id: 'client-123',
		redirect_uri: callbackUri,
		error_description: invalidClientIdMismatchMessage,
	}
	const authorizeInfoResponse = await handleAuthorizeInfo(
		new Request(
			exampleOAuthUrl('authorize-info', {
				response_type: 'code',
				...mismatchParams,
			}),
		),
		createEnv(clientMismatch.helpers, sharedClientDb),
	)
	const resetVerificationCookie =
		authorizeInfoResponse.headers.get('Set-Cookie') ?? ''
	expect(
		await resetClient(
			exampleOAuthUrl('authorize', mismatchParams),
			clientMismatch,
			sharedClientDb,
			`${getCookiePair(cookie)}; ${getCookiePair(resetVerificationCookie)}`,
		),
	).toEqual(resetSucceeded(revokedAccount, ['grant-1', 'grant-2']))

	const localhostRedirect = resetClientHelpers(userId, [
		['grant-1', 'client-123', 'profile'],
	])
	expect(
		await resetClient(
			exampleOAuthUrl('authorize', {
				client_id: 'client-123',
				redirect_uri: 'https://localhost:8888/callback',
			}),
			localhostRedirect,
			sharedClientDb,
			cookie,
		),
	).toEqual(resetSucceeded(revokedAccount, ['grant-1']))

	const ownedClient = resetClientHelpers(
		userId,
		[['grant-owned', 'client-123', 'profile']],
		redirectUriMismatchMessage,
	)
	const ownedClientDb = await createDatabase('password123', {
		ownedClientIds: ['client-123'],
	})
	expect(
		await resetClient(invalidRedirectUrl, ownedClient, ownedClientDb, cookie),
	).toEqual(
		resetSucceeded(
			/deleted your stored client registration/i,
			['grant-owned'],
			['client-123'],
		),
	)
})

test('reset client rejects requests without a stale or mismatched client registration', async () => {
	const workerEnv = createEnv(createHelpers())
	for (const errorDescription of [
		invalidClientIdMismatchMessage,
		'Authorization error',
	]) {
		const response = await postResetClient(
			exampleOAuthUrl('authorize', {
				client_id: 'client-123',
				redirect_uri: callbackUri,
				error_description: errorDescription,
			}),
			workerEnv,
		)
		expect(response.status).toBe(400)
		await expect(response.json()).resolves.toEqual({
			ok: false,
			error:
				'Stored client cleanup is only available for stale or mismatched client registrations.',
			code: 'invalid_request',
		})
	}
})

test('worker entrypoint rejects unsupported implicit response_type on authorize-info', async () => {
	const clientId = await registerClient({
		client_name: 'OIDC response type test',
		redirect_uris: [callbackUri],
		token_endpoint_auth_method: 'none',
		grant_types: ['authorization_code'],
		response_types: ['code'],
	})
	const response = await workerFetch(
		new Request(
			exampleOAuthUrl(
				'authorize-info',
				{
					response_type: 'id_token',
					client_id: clientId,
					redirect_uri: callbackUri,
					scope: 'openid',
				},
				'https://heykody.dev',
			),
		),
	)
	expect(response.status).toBe(400)
	await expect(response.json()).resolves.toMatchObject({
		ok: false,
		error: expect.stringMatching(
			/response_type id_token|unsupported response type/i,
		),
	})
})

test('worker entrypoint returns id_token when openid scope is granted and serves userinfo for the bearer token', async () => {
	const email = `oidc-oauth-${crypto.randomUUID()}@example.com`
	await seedWorkerUser(email)
	const clientId = `https://oidc-client.example/${crypto.randomUUID()}.json`
	const redirectUri = 'https://oidc-client.example/callback'
	using _fetch = stubClientMetadataFetch(clientId, () =>
		jsonResponse({
			client_id: clientId,
			redirect_uris: [redirectUri],
			token_endpoint_auth_method: 'none',
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			client_name: 'OIDC test client',
		}),
	)
	const verifier = 'oidc-verifier-012345678901234567890'
	const authorizeUrl = await heykodyAuthorizeUrl(
		{
			client_id: clientId,
			redirect_uri: redirectUri,
			scope: 'openid profile email',
			nonce: 'oidc-test-nonce',
			state: 'oidc-demo-state',
		},
		verifier,
	)
	const { code } = await workerApprove(authorizeUrl, email)

	// Authorize (default handler) injects `env.OAUTH_PROVIDER` onto the
	// shared isolate env. Production token requests are a fresh isolate
	// and the token path never injects helpers — hide the leftover so
	// enrichment must use `resolveOAuthHelpers` over OAUTH_KV.
	const tokenEnv = new Proxy(env, {
		get(target, prop, receiver) {
			if (prop === 'OAUTH_PROVIDER') return undefined
			return Reflect.get(target, prop, receiver)
		},
	}) as Env

	const tokenResponse = await exchangeCode(
		{
			client_id: clientId,
			code,
			redirect_uri: redirectUri,
			code_verifier: verifier,
		},
		tokenEnv,
	)
	expect(tokenResponse.status).toBe(200)
	const tokenPayload = (await tokenResponse.json()) as {
		access_token?: string
		id_token?: string
		scope?: string
	}
	expect(tokenPayload.scope).toContain('openid')
	expect(typeof tokenPayload.id_token).toBe('string')
	expect(tokenPayload.id_token?.split('.')).toHaveLength(3)
	expect(typeof tokenPayload.access_token).toBe('string')

	const userinfoResponse = await workerFetch(
		new Request('https://heykody.dev/oauth/userinfo', {
			headers: { Authorization: `Bearer ${tokenPayload.access_token ?? ''}` },
		}),
		tokenEnv,
	)
	expect(userinfoResponse.status).toBe(200)
	await expect(userinfoResponse.json()).resolves.toMatchObject({
		email,
		email_verified: true,
	})
})

test('malformed max_age does not redirect authorize GET to itself', async () => {
	const authorizeUrl = exampleOAuthUrl('authorize', {
		...baseAuthorizeParams,
		scope: 'openid',
		max_age: 'not-a-number',
	})

	const interactive = await handleAuthorizeRequest(
		new Request(authorizeUrl),
		createEnv(createHelpers()),
	)
	expect(interactive.headers.get('Location')).toBeNull()
	expect(await readAuthorizePage(interactive)).toMatch(
		/max_age must be a non-negative integer/i,
	)

	const silent = await handleAuthorizeRequest(
		new Request(`${authorizeUrl}&prompt=none`),
		createEnv(createHelpers()),
	)
	expect(silent.status).toBe(302)
	const silentLocation = silent.headers.get('Location')
	expect(silentLocation).toBeTruthy()
	expectRedirect(silentLocation ?? '', callbackUri, {
		error: 'invalid_request',
		state: 'demo',
	})
	expect(
		new URL(silentLocation ?? '').searchParams.get('error_description'),
	).toMatch(/max_age must be a non-negative integer/i)
})

test('authorize recovers when a pre-hydration submit clobbers the OAuth query', async () => {
	const envWithHelpers = createEnv(
		createHelpers({
			parseAuthRequest: async () => {
				throw new Error('client_id is required')
			},
		}),
	)

	const htmlResponse = await handleAuthorizeRequest(
		new Request(`https://example.com/oauth/authorize?${honeypotFieldName}=`),
		envWithHelpers,
	)
	expect(htmlResponse.status).toBe(200)
	const html = await htmlResponse.text()
	expect(html).toContain(oauthAuthorizeClobberedResubmitMessage)
	expect(html).not.toContain('client_id is required')
	expect(html).not.toContain('data-testid="oauth-authorize-approve"')

	const infoResponse = await handleAuthorizeInfo(
		new Request(
			`https://example.com/oauth/authorize-info?${honeypotFieldName}=`,
		),
		envWithHelpers,
	)
	expect(infoResponse.status).toBe(400)
	await expect(infoResponse.json()).resolves.toEqual({
		ok: false,
		error: oauthAuthorizeClobberedResubmitMessage,
		allowClientReset: false,
	})

	const postResponse = await handleAuthorizeRequest(
		formRequest({ decision: 'approve', [honeypotFieldName]: '' }, jsonAccept),
		envWithHelpers,
	)
	expect(postResponse.status).toBe(400)
	await expect(postResponse.json()).resolves.toMatchObject({
		ok: false,
		error: oauthAuthorizeClobberedResubmitMessage,
	})
})
