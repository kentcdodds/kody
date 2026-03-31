import { expect, test } from 'vitest'
import {
	createAuthenticatedFetch,
	createExecuteHelperPrelude,
	getExecuteHelperCapabilityNames,
	refreshAccessToken,
} from './codemode-utils.ts'

type SecretSetCall = {
	name: string
	value: string
	scope: string
}

const spotifyConnector = {
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
		async connector_get({ name }: { name: string }) {
			expect(name).toBe('spotify')
			return { connector: spotifyConnector }
		},
		async value_get({ name }: { name: string }) {
			expect(name).toBe('spotifyClientId')
			return { value: 'spotify-client-id' }
		},
		async secret_set(args: SecretSetCall) {
			secretSetCalls.push(args)
			return {
				name: args.name,
				scope: args.scope,
			}
		},
	}

	const fetchCalls: Array<Request> = []
	const fetchStub = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init)
		fetchCalls.push(request)
		if (request.url === spotifyConnector.tokenUrl) {
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
	) as (
		codemode: typeof codemode,
	) => {
		refreshAccessToken: (providerName: string) => Promise<string>
		createAuthenticatedFetch: (
			providerName: string,
		) => Promise<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>
	}

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

test('getExecuteHelperCapabilityNames includes secret_set for refresh persistence', () => {
	expect(getExecuteHelperCapabilityNames()).toEqual([
		'connector_get',
		'value_get',
		'secret_set',
	])
})
