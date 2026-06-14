import { expect, test } from 'vitest'
import {
	type CapabilityArgs,
	type CodemodeNamespace,
	type ExecuteRequestInput,
	createAuthenticatedFetch,
	createExecuteHelperPrelude,
	oauthClientCredentials,
	refreshAccessToken,
	type secretHeaders,
} from './codemode-utils.ts'

type SecretSetCall = {
	name: string
	value: string
	scope: string
}

type SandboxHelpers = {
	refreshAccessToken: (providerName: string) => Promise<string>
	createAuthenticatedFetch: (
		providerName: string,
	) => Promise<
		(input: ExecuteRequestInput, init?: RequestInit) => Promise<Response>
	>
	secretHeaders: typeof secretHeaders
	oauthClientCredentials: typeof oauthClientCredentials
}

type ApiResponseSpec = {
	status: number
	body: Record<string, unknown>
}

const spotifyIntegration = {
	name: 'spotify',
	tokenUrl: 'https://accounts.spotify.test/api/token',
	apiBaseUrl: 'https://api.spotify.test/v1',
	flow: 'pkce' as const,
	clientIdValueName: 'spotifyClientId',
	clientSecretSecretName: null,
	accessTokenSecretName: 'spotifyAccessToken',
	refreshTokenSecretName: 'spotifyRefreshToken',
	requiredHosts: ['api.spotify.test'],
}

function createCodemode(
	payload: Record<string, unknown>,
	options: {
		apiErrors?: Array<Error>
		apiResponses?: Array<ApiResponseSpec>
	} = {},
) {
	const secretSetCalls: Array<SecretSetCall> = []
	const apiErrors = [...(options.apiErrors ?? [])]
	const apiResponses = [...(options.apiResponses ?? [])]
	const codemode = {
		async integration_get(args: CapabilityArgs) {
			const name = args.name
			expect(name).toBe('spotify')
			return { integration: spotifyIntegration }
		},
		async value_get(args: CapabilityArgs) {
			const name = args.name
			expect(name).toBe('spotifyClientId')
			return { value: 'spotify-client-id' }
		},
		async secret_set(args: CapabilityArgs) {
			const call = args as SecretSetCall
			secretSetCalls.push(call)
			return {
				name: call.name,
				scope: call.scope,
			}
		},
	} satisfies CodemodeNamespace

	const fetchCalls: Array<Request> = []
	const fetchStub: typeof globalThis.fetch = async (
		input: ExecuteRequestInput,
		init?: RequestInit,
	) => {
		const request = new Request(input, init)
		fetchCalls.push(request)
		if (request.url === spotifyIntegration.tokenUrl) {
			return new Response(JSON.stringify(payload), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})
		}
		const apiError = apiErrors.shift()
		if (apiError) throw apiError
		const apiResponse = apiResponses.shift()
		if (apiResponse) {
			return new Response(JSON.stringify(apiResponse.body), {
				status: apiResponse.status,
				headers: { 'content-type': 'application/json' },
			})
		}
		return new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})
	}

	return { codemode, secretSetCalls, fetchCalls, fetchStub }
}

async function withPatchedFetch<T>(
	fetchImpl: typeof globalThis.fetch,
	callback: () => Promise<T>,
) {
	const originalFetch = globalThis.fetch
	globalThis.fetch = fetchImpl
	try {
		return await callback()
	} finally {
		globalThis.fetch = originalFetch
	}
}

test('codemode oauth helpers refresh tokens, retry on missing or expired access tokens, and persist rotations', async () => {
	const rotatedRefresh = createCodemode({
		access_token: 'new-access-token',
		refresh_token: 'new-refresh-token',
	})
	const rotatedAccessToken = await withPatchedFetch(
		rotatedRefresh.fetchStub,
		() => refreshAccessToken(rotatedRefresh.codemode, 'spotify'),
	)
	expect(rotatedAccessToken).toBe('new-access-token')
	expect(rotatedRefresh.secretSetCalls).toEqual([
		{
			name: 'spotifyRefreshToken',
			value: 'new-refresh-token',
			scope: 'user',
		},
		{
			name: 'spotifyAccessToken',
			value: 'new-access-token',
			scope: 'user',
		},
	])
	expect(rotatedRefresh.fetchCalls).toHaveLength(1)
	expect(rotatedRefresh.fetchCalls[0]?.method).toBe('POST')
	expect(await rotatedRefresh.fetchCalls[0]?.text()).toContain(
		'refresh_token=%7B%7Bsecret%3AspotifyRefreshToken%7Cscope%3Duser%7D%7D',
	)

	const storedToken = createCodemode({
		access_token: 'refreshed-access-token',
	})
	const authenticatedFetch = await createAuthenticatedFetch(
		storedToken.codemode,
		'spotify',
	)
	const storedTokenResponse = await withPatchedFetch(
		storedToken.fetchStub,
		() => authenticatedFetch('/me/playlists', { method: 'POST' }),
	)
	expect(storedToken.secretSetCalls).toEqual([])
	expect(storedToken.fetchCalls).toHaveLength(1)
	expect(storedToken.fetchCalls[0]?.url).toBe(
		'https://api.spotify.test/v1/me/playlists',
	)
	expect(storedToken.fetchCalls[0]?.headers.get('authorization')).toBe(
		'Bearer {{secret:spotifyAccessToken|scope=user}}',
	)
	expect(await storedTokenResponse.json()).toEqual({ ok: true })

	const missingToken = createCodemode(
		{
			access_token: 'new-access-token',
		},
		{
			apiErrors: [new Error('Secret "spotifyAccessToken" was not found.')],
		},
	)
	const missingTokenFetch = await createAuthenticatedFetch(
		missingToken.codemode,
		'spotify',
	)
	const missingTokenResponse = await withPatchedFetch(
		missingToken.fetchStub,
		() => missingTokenFetch('/me?market=US'),
	)
	expect(missingToken.secretSetCalls).toEqual([
		{
			name: 'spotifyAccessToken',
			value: 'new-access-token',
			scope: 'user',
		},
	])
	expect(missingToken.fetchCalls).toHaveLength(3)
	expect(missingToken.fetchCalls[0]?.headers.get('authorization')).toBe(
		'Bearer {{secret:spotifyAccessToken|scope=user}}',
	)
	expect(missingToken.fetchCalls[1]?.url).toBe(
		'https://accounts.spotify.test/api/token',
	)
	expect(missingToken.fetchCalls[2]?.headers.get('authorization')).toBe(
		'Bearer new-access-token',
	)
	expect(await missingTokenResponse.json()).toEqual({ ok: true })

	const expiredToken = createCodemode(
		{
			access_token: 'new-access-token',
		},
		{
			apiResponses: [
				{ status: 401, body: { error: 'expired' } },
				{ status: 200, body: { ok: true } },
			],
		},
	)
	const expiredTokenFetch = await createAuthenticatedFetch(
		expiredToken.codemode,
		'spotify',
	)
	const expiredTokenResponse = await withPatchedFetch(
		expiredToken.fetchStub,
		() => expiredTokenFetch('/me?market=US'),
	)
	expect(expiredToken.secretSetCalls).toEqual([
		{
			name: 'spotifyAccessToken',
			value: 'new-access-token',
			scope: 'user',
		},
	])
	expect(expiredToken.fetchCalls).toHaveLength(3)
	expect(expiredToken.fetchCalls[0]?.url).toBe(
		'https://api.spotify.test/v1/me?market=US',
	)
	expect(expiredToken.fetchCalls[1]?.url).toBe(
		'https://accounts.spotify.test/api/token',
	)
	expect(expiredToken.fetchCalls[2]?.headers.get('authorization')).toBe(
		'Bearer new-access-token',
	)
	expect(await expiredTokenResponse.json()).toEqual({ ok: true })
})

test('createExecuteHelperPrelude exposes sandbox helpers for token refresh, authenticated fetch, secrets, and client credentials', async () => {
	const prelude = createExecuteHelperPrelude()
	const createSandboxHelpers = new Function(
		'codemode',
		`${prelude}; return { refreshAccessToken, createAuthenticatedFetch, secretHeaders, oauthClientCredentials };`,
	) as (codemodeNamespace: CodemodeNamespace) => SandboxHelpers

	const { codemode, secretSetCalls, fetchStub, fetchCalls } = createCodemode({
		access_token: 'new-access-token',
		refresh_token: 'new-refresh-token',
	})
	const helpers = createSandboxHelpers(codemode)
	const accessToken = await withPatchedFetch(fetchStub, () =>
		helpers.refreshAccessToken('spotify'),
	)
	const authenticatedFetch = await withPatchedFetch(fetchStub, () =>
		helpers.createAuthenticatedFetch('spotify'),
	)
	await withPatchedFetch(fetchStub, () => authenticatedFetch('/me'))

	expect(accessToken).toBe('new-access-token')
	expect(secretSetCalls).toEqual([
		{
			name: 'spotifyRefreshToken',
			value: 'new-refresh-token',
			scope: 'user',
		},
		{
			name: 'spotifyAccessToken',
			value: 'new-access-token',
			scope: 'user',
		},
	])
	expect(fetchCalls).toHaveLength(2)
	expect(fetchCalls[1]?.headers.get('authorization')).toBe(
		'Bearer {{secret:spotifyAccessToken|scope=user}}',
	)

	expect(
		helpers.secretHeaders.basic({
			usernameSecret: 'paypalClientId',
			passwordSecret: 'paypalClientSecret',
			scope: 'user',
		}),
	).toBe(
		'{{secret-basic:username=paypalClientId,password=paypalClientSecret|scope=user}}',
	)

	const clientCredentialsCalls: Array<Request> = []
	const clientCredentialsStub: typeof globalThis.fetch = async (
		input: ExecuteRequestInput,
		init?: RequestInit,
	) => {
		const request = new Request(input, init)
		clientCredentialsCalls.push(request)
		return new Response(
			JSON.stringify({
				access_token: 'paypal-access-token',
				token_type: 'Bearer',
			}),
			{
				status: 200,
				headers: { 'content-type': 'application/json' },
			},
		)
	}
	const tokenResponse = await withPatchedFetch(clientCredentialsStub, () =>
		helpers.oauthClientCredentials({
			tokenUrl: 'https://api-m.paypal.com/v1/oauth2/token',
			clientIdSecret: 'paypalClientId',
			clientSecretSecret: 'paypalClientSecret',
			scope: 'user',
			body: {
				scope: 'openid',
			},
		}),
	)
	expect(tokenResponse).toEqual({
		access_token: 'paypal-access-token',
		token_type: 'Bearer',
	})
	expect(clientCredentialsCalls).toHaveLength(1)
	expect(clientCredentialsCalls[0]?.method).toBe('POST')
	expect(clientCredentialsCalls[0]?.headers.get('authorization')).toBe(
		'{{secret-basic:username=paypalClientId,password=paypalClientSecret|scope=user}}',
	)
	expect(clientCredentialsCalls[0]?.headers.get('content-type')).toBe(
		'application/x-www-form-urlencoded',
	)
	expect(await clientCredentialsCalls[0]?.text()).toBe(
		new URLSearchParams({
			scope: 'openid',
			grant_type: 'client_credentials',
		}).toString(),
	)
})
