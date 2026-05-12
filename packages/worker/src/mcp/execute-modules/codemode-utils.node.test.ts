import { expect, test } from 'vitest'
import {
	type CapabilityArgs,
	type CodemodeNamespace,
	type ExecuteRequestInput,
	createAuthenticatedFetch,
	createExecuteHelperPrelude,
	getExecuteHelperCapabilityNames,
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

function createCodemode(payload: Record<string, unknown>) {
	const secretSetCalls: Array<SecretSetCall> = []
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

test('createAuthenticatedFetch persists refreshed access token even without refresh token rotation', async () => {
	const { codemode, secretSetCalls, fetchStub, fetchCalls } = createCodemode({
		access_token: 'new-access-token',
	})

	const authenticatedFetch = await withPatchedFetch(fetchStub, () =>
		createAuthenticatedFetch(codemode, 'spotify'),
	)
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
	expect(fetchCalls).toHaveLength(2)
	expect(fetchCalls[1]?.url).toBe('https://api.spotify.test/v1/me?market=US')
	expect(fetchCalls[1]?.headers.get('authorization')).toBe(
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
	expect(fetchCalls).toHaveLength(3)
	expect(fetchCalls[2]?.headers.get('authorization')).toBe(
		'Bearer new-access-token',
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

test('getExecuteHelperCapabilityNames includes secret_set for refresh persistence', () => {
	expect(getExecuteHelperCapabilityNames()).toEqual([
		'integration_get',
		'value_get',
		'secret_set',
	])
})
