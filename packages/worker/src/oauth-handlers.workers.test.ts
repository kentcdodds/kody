import { expect, test } from 'vitest'
import {
	type AuthRequest,
	type ClientInfo,
	type CompleteAuthorizationOptions,
	type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider'
import { createAuthCookie, setAuthSessionSecret } from '#app/auth-session.ts'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { invalidClientIdMismatchMessage } from '@kody-internal/shared/oauth-messages.ts'
import {
	handleAuthorizeInfo,
	handleAuthorizeRequest,
	handleOAuthCallback,
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
		prepare() {
			return {
				bind() {
					return {
						async all() {
							return {
								results: [{ id: 1, password_hash: passwordHash }],
								meta: { changes: 0, last_row_id: 0 },
							}
						},
						async first() {
							return { id: 1, password_hash: passwordHash }
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

function mockSchedulerDoNamespace(): DurableObjectNamespace {
	return {
		idFromName() {
			return { toString: () => 'scheduler-do-test-id' } as DurableObjectId
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
		COOKIE_SECRET: cookieSecretValue,
		SCHEDULER_DO: mockSchedulerDoNamespace(),
	} as unknown as Env
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

test('authorize page returns SPA shell', async () => {
	const response = await handleAuthorizeRequest(
		new Request('https://example.com/oauth/authorize'),
		createEnv(createHelpers()),
	)

	expect(response.status).toBe(200)
	const body = await response.text()
	expect(body).toContain('client-entry.js')
	expect(body).toContain('app-shell')
})

test('authorize info returns client and scopes', async () => {
	const response = await handleAuthorizeInfo(
		new Request(
			'https://example.com/oauth/authorize-info?response_type=code&client_id=client-123&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&scope=profile&state=demo',
		),
		createEnv(createHelpers()),
	)

	expect(response.status).toBe(200)
	const payload = await response.json()
	expect(payload).toEqual({
		ok: true,
		client: { id: baseClient.clientId, name: baseClient.clientName },
		scopes: baseAuthRequest.scope,
	})
})

test('authorize denies access and redirects with error', async () => {
	const response = await handleAuthorizeRequest(
		createFormRequest({ decision: 'deny' }),
		createEnv(createHelpers()),
	)

	expect(response.status).toBe(302)
	const location = response.headers.get('Location')
	expect(location).toBeTruthy()
	const redirectUrl = new URL(location as string)
	const expectedRedirect = new URL(baseAuthRequest.redirectUri)
	expect(redirectUrl.origin).toBe(expectedRedirect.origin)
	expect(redirectUrl.pathname).toBe(expectedRedirect.pathname)
	expect(redirectUrl.searchParams.get('error')).toBe('access_denied')
	expect(redirectUrl.searchParams.get('state')).toBe('demo')
})

test('authorize requires email and password for approval', async () => {
	const response = await handleAuthorizeRequest(
		createFormRequest(
			{ decision: 'approve', email: 'user@example.com' },
			{ Accept: 'application/json' },
		),
		createEnv(createHelpers()),
	)

	expect(response.status).toBe(400)
	const payload = await response.json()
	expect(payload).toEqual({
		ok: false,
		error: 'Email and password are required.',
		code: 'invalid_request',
	})
})

test('authorize allows approval with an existing session', async () => {
	let capturedOptions: CompleteAuthorizationOptions | null = null
	const helpers = createHelpers({
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

	const response = await handleAuthorizeRequest(
		createFormRequest(
			{ decision: 'approve' },
			{ Accept: 'application/json', Cookie: cookie },
		),
		createEnv(helpers),
	)

	expect(response.status).toBe(200)
	const payload = await response.json()
	expect(payload).toEqual({
		ok: true,
		redirectTo: 'https://example.com/callback?code=session',
	})
	expect(capturedOptions).not.toBeNull()
})

test('authorize uses default scopes when none requested', async () => {
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
	const response = await handleAuthorizeRequest(
		createFormRequest({
			decision: 'approve',
			email: 'user@example.com',
			password: 'password123',
		}),
		createEnv(helpers, await createDatabase('password123')),
	)

	expect(response.status).toBe(302)
	expect(response.headers.get('Location')).toBe(
		'https://example.com/callback?code=ok',
	)
	const capturedOptions = await capturedOptionsPromise
	expect(capturedOptions.scope).toEqual(oauthScopes)
})

test('reset client deletes matching grants and client registration', async () => {
	const revokedGrantIds = new Array<string>()
	const deletedClientIds = new Array<string>()
	const userId = await createStableUserIdFromEmail('user@example.com')
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
			revokedGrantIds.push(grantId)
		},
		deleteClient: async (clientId) => {
			deletedClientIds.push(clientId)
		},
	})
	setAuthSessionSecret(cookieSecret)
	const cookie = await createAuthCookie(
		{ id: 'session-id', email: 'user@example.com', rememberMe: false },
		false,
	)

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
		createEnv(helpers),
	)

	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toEqual({
		ok: true,
		message:
			'Deleted the stored client records for this connection. Start the connection again from your client to create a fresh trusted client.',
	})
	expect(revokedGrantIds).toEqual(['grant-1', 'grant-3'])
	expect(deletedClientIds).toEqual(['client-123'])
})

test('reset client deletes stale client registrations after invalid client mismatch', async () => {
	const revokedGrantIds = new Array<string>()
	const deletedClientIds = new Array<string>()
	const userId = await createStableUserIdFromEmail('user@example.com')
	const helpers = createHelpers({
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
			revokedGrantIds.push(grantId)
		},
		deleteClient: async (clientId) => {
			deletedClientIds.push(clientId)
		},
	})
	setAuthSessionSecret(cookieSecret)
	const cookie = await createAuthCookie(
		{ id: 'session-id', email: 'user@example.com', rememberMe: false },
		false,
	)

	const response = await handleAuthorizeRequest(
		new Request(
			`https://example.com/oauth/authorize?client_id=client-123&redirect_uri=${encodeURIComponent('https://example.com/callback')}&error_description=${encodeURIComponent(invalidClientIdMismatchMessage)}`,
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
		createEnv(helpers),
	)

	expect(response.status).toBe(400)
	await expect(response.json()).resolves.toEqual({
		ok: false,
		error:
			'Stored client cleanup is only available for stale or mismatched client registrations.',
		code: 'invalid_request',
	})
	expect(revokedGrantIds).toEqual([])
	expect(deletedClientIds).toEqual([])
})

test('reset client is rejected when the request is not a redirect mismatch', async () => {
	const response = await handleAuthorizeRequest(
		new Request(
			`https://example.com/oauth/authorize?client_id=client-123&redirect_uri=${encodeURIComponent('https://example.com/callback')}&error_description=Authorization%20error`,
			{
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({ decision: 'reset-client' }),
			},
		),
		createEnv(createHelpers()),
	)

	expect(response.status).toBe(400)
	await expect(response.json()).resolves.toEqual({
		ok: false,
		error:
			'Stored client cleanup is only available for stale or mismatched client registrations.',
		code: 'invalid_request',
	})
})

test('reset client also works when the mismatch came from authorize-info loading', async () => {
	const deletedClientIds = new Array<string>()
	const revokedGrantIds = new Array<string>()
	const userId = await createStableUserIdFromEmail('user@example.com')
	const helpers = createHelpers({
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
			revokedGrantIds.push(grantId)
		},
		deleteClient: async (clientId) => {
			deletedClientIds.push(clientId)
		},
	})
	setAuthSessionSecret(cookieSecret)
	const cookie = await createAuthCookie(
		{ id: 'session-id', email: 'user@example.com', rememberMe: false },
		false,
	)

	const response = await handleAuthorizeRequest(
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
		createEnv(helpers),
	)

	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toEqual({
		ok: true,
		message:
			'Deleted the stored client records for this connection. Start the connection again from your client to create a fresh trusted client.',
	})
	expect(revokedGrantIds).toEqual(['grant-1'])
	expect(deletedClientIds).toEqual(['client-123'])
})

test('oauth callback page returns SPA shell', async () => {
	const response = handleOAuthCallback(
		new Request('https://example.com/oauth/callback?code=abc123&state=demo'),
	)

	expect(response.status).toBe(200)
	const body = await response.text()
	expect(body).toContain('client-entry.js')
	expect(body).toContain('app-shell')
})
