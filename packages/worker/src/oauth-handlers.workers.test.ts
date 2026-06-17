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
								results: [
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
