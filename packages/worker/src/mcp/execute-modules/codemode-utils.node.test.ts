import { expect, test } from 'vitest'
import {
	type CapabilityArgs,
	type CodemodeNamespace,
	type ExecuteRequestInput,
	createAuthenticatedFetch,
	createExecuteHelperPrelude,
	oauthClientCredentials,
	refreshAccessToken,
	secretHeaders,
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

test('refreshAccessToken persists rotated refresh token and access token', async () => {
	const { codemode, secretSetCalls, fetchStub, fetchCalls } = createCodemode({
		access_token: 'new-access-token',
		refresh_token: 'new-refresh-token',
	})

	const accessToken = await withPatchedFetch(fetchStub, () =>
		refreshAccessToken(codemode, 'spotify'),
	)

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
	expect(fetchCalls).toHaveLength(1)
	expect(fetchCalls[0]?.method).toBe('POST')
	expect(await fetchCalls[0]?.text()).toContain(
		'refresh_token=%7B%7Bsecret%3AspotifyRefreshToken%7Cscope%3Duser%7D%7D',
	)
})

test('createAuthenticatedFetch uses the stored access token before refreshing', async () => {
	const { codemode, secretSetCalls, fetchStub, fetchCalls } = createCodemode({
		access_token: 'refreshed-access-token',
	})

	const authenticatedFetch = await createAuthenticatedFetch(codemode, 'spotify')
	const response = await withPatchedFetch(fetchStub, () =>
		authenticatedFetch('/me/playlists', { method: 'POST' }),
	)

	expect(secretSetCalls).toEqual([])
	expect(fetchCalls).toHaveLength(1)
	expect(fetchCalls[0]?.url).toBe('https://api.spotify.test/v1/me/playlists')
	expect(fetchCalls[0]?.headers.get('authorization')).toBe(
		'Bearer {{secret:spotifyAccessToken|scope=user}}',
	)
	expect(await response.json()).toEqual({ ok: true })
})

test('createAuthenticatedFetch refreshes when the stored access token secret is missing', async () => {
	const { codemode, secretSetCalls, fetchStub, fetchCalls } = createCodemode(
		{
			access_token: 'new-access-token',
		},
		{
			apiErrors: [new Error('Secret "spotifyAccessToken" was not found.')],
		},
	)

	const authenticatedFetch = await createAuthenticatedFetch(codemode, 'spotify')
	const response = await withPatchedFetch(fetchStub, () =>
		authenticatedFetch('/me?market=US'),
	)

	expect(secretSetCalls).toEqual([
		{
			name: 'spotifyAccessToken',
			value: 'new-access-token',
			scope: 'user',
		},
	])
	expect(fetchCalls).toHaveLength(3)
	expect(fetchCalls[0]?.headers.get('authorization')).toBe(
		'Bearer {{secret:spotifyAccessToken|scope=user}}',
	)
	expect(fetchCalls[1]?.url).toBe('https://accounts.spotify.test/api/token')
	expect(fetchCalls[2]?.headers.get('authorization')).toBe(
		'Bearer new-access-token',
	)
	expect(await response.json()).toEqual({ ok: true })
})

test('createAuthenticatedFetch persists refreshed access token even without refresh token rotation', async () => {
	const { codemode, secretSetCalls, fetchStub, fetchCalls } = createCodemode(
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

	const authenticatedFetch = await createAuthenticatedFetch(codemode, 'spotify')
	const response = await withPatchedFetch(fetchStub, () =>
		authenticatedFetch('/me?market=US'),
	)

	expect(secretSetCalls).toEqual([
		{
			name: 'spotifyAccessToken',
			value: 'new-access-token',
			scope: 'user',
		},
	])
	expect(fetchCalls).toHaveLength(3)
	expect(fetchCalls[0]?.url).toBe('https://api.spotify.test/v1/me?market=US')
	expect(fetchCalls[0]?.headers.get('authorization')).toBe(
		'Bearer {{secret:spotifyAccessToken|scope=user}}',
	)
	expect(fetchCalls[1]?.url).toBe('https://accounts.spotify.test/api/token')
	expect(fetchCalls[2]?.url).toBe('https://api.spotify.test/v1/me?market=US')
	expect(fetchCalls[2]?.headers.get('authorization')).toBe(
		'Bearer new-access-token',
	)
	expect(await response.json()).toEqual({ ok: true })
})

test('createExecuteHelperPrelude persists rotated refresh token and access token', async () => {
	const { codemode, secretSetCalls, fetchStub, fetchCalls } = createCodemode({
		access_token: 'new-access-token',
		refresh_token: 'new-refresh-token',
	})
	const prelude = createExecuteHelperPrelude()
	const createSandboxHelpers = new Function(
		'codemode',
		`${prelude}; return { refreshAccessToken, createAuthenticatedFetch };`,
	) as (codemodeNamespace: CodemodeNamespace) => SandboxHelpers

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
})

test('secretHeaders.basic returns an opaque Basic Auth placeholder', () => {
	expect(
		secretHeaders.basic({
			usernameSecret: 'paypalClientId',
			passwordSecret: 'paypalClientSecret',
			scope: 'user',
		}),
	).toBe(
		'{{secret-basic:username=paypalClientId,password=paypalClientSecret|scope=user}}',
	)
})

test('oauthClientCredentials posts a Basic placeholder through fetch', async () => {
	const fetchCalls: Array<Request> = []
	const fetchStub: typeof globalThis.fetch = async (
		input: ExecuteRequestInput,
		init?: RequestInit,
	) => {
		const request = new Request(input, init)
		fetchCalls.push(request)
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

	const tokenResponse = await withPatchedFetch(fetchStub, () =>
		oauthClientCredentials({
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
	expect(fetchCalls).toHaveLength(1)
	expect(fetchCalls[0]?.method).toBe('POST')
	expect(fetchCalls[0]?.headers.get('authorization')).toBe(
		'{{secret-basic:username=paypalClientId,password=paypalClientSecret|scope=user}}',
	)
	expect(fetchCalls[0]?.headers.get('content-type')).toBe(
		'application/x-www-form-urlencoded',
	)
	expect(await fetchCalls[0]?.text()).toBe(
		new URLSearchParams({
			scope: 'openid',
			grant_type: 'client_credentials',
		}).toString(),
	)
})

test('createExecuteHelperPrelude exposes secret and client credentials helpers', async () => {
	const prelude = createExecuteHelperPrelude()
	const createSandboxHelpers = new Function(
		'codemode',
		`${prelude}; return { secretHeaders, oauthClientCredentials };`,
	) as (codemodeNamespace: CodemodeNamespace) => SandboxHelpers
	const fetchCalls: Array<Request> = []
	const fetchStub: typeof globalThis.fetch = async (
		input: ExecuteRequestInput,
		init?: RequestInit,
	) => {
		const request = new Request(input, init)
		fetchCalls.push(request)
		return new Response(JSON.stringify({ access_token: 'access-token' }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})
	}

	const helpers = createSandboxHelpers({} satisfies CodemodeNamespace)
	expect(
		helpers.secretHeaders.basic({
			usernameSecret: 'paypalClientId',
			passwordSecret: 'paypalClientSecret',
			scope: 'user',
		}),
	).toBe(
		'{{secret-basic:username=paypalClientId,password=paypalClientSecret|scope=user}}',
	)
	await withPatchedFetch(fetchStub, () =>
		helpers.oauthClientCredentials({
			tokenUrl: 'https://api-m.paypal.com/v1/oauth2/token',
			clientIdSecret: 'paypalClientId',
			clientSecretSecret: 'paypalClientSecret',
			scope: 'user',
		}),
	)
	expect(fetchCalls[0]?.headers.get('authorization')).toBe(
		'{{secret-basic:username=paypalClientId,password=paypalClientSecret|scope=user}}',
	)
})
