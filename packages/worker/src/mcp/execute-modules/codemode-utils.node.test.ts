import { expect, test } from 'vitest'
import {
	createAuthenticatedFetch,
	createCodemodeUtils,
	refreshAccessToken,
} from './codemode-utils.ts'

type CodemodeUtilsNamespace = Parameters<typeof refreshAccessToken>[0]

type MockCodemode = {
	connector_get: (args: { name: string }) => Promise<{
		connector: {
			name: string
			tokenUrl: string
			apiBaseUrl: string | null
			flow: 'pkce' | 'confidential'
			clientIdValueName: string
			clientSecretSecretName: string | null
			accessTokenSecretName: string
			refreshTokenSecretName: string | null
			requiredHosts?: Array<string>
		} | null
	}>
	value_get: (args: { name: string }) => Promise<{ value: string } | null>
}

function createMockCodemode(
	overrides?: Partial<{
		connector: Awaited<ReturnType<MockCodemode['connector_get']>>['connector']
		clientId: string | null
	}>,
): MockCodemode {
	return {
		async connector_get() {
			return {
				connector:
					'connector' in (overrides ?? {})
						? (overrides?.connector ?? null)
						: {
								name: 'spotify',
								tokenUrl: 'https://accounts.spotify.com/api/token',
								apiBaseUrl: 'https://api.spotify.com/v1',
								flow: 'pkce',
								clientIdValueName: 'spotify-client-id',
								clientSecretSecretName: null,
								accessTokenSecretName: 'spotifyAccessToken',
								refreshTokenSecretName: 'spotifyRefreshToken',
								requiredHosts: ['accounts.spotify.com', 'api.spotify.com'],
							},
			}
		},
		async value_get() {
			if (overrides?.clientId === null) return null
			return { value: overrides?.clientId ?? 'spotify-client-id-value' }
		},
	}
}

test('refreshAccessToken posts refresh-token form payload and returns the token', async () => {
	const codemode = createMockCodemode() as unknown as CodemodeUtilsNamespace
	const requests: Array<Request> = []
	const originalFetch = globalThis.fetch

	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init)
		requests.push(request)
		return Response.json({
			access_token: 'fresh-access-token',
			token_type: 'Bearer',
		})
	}

	try {
		const token = await refreshAccessToken(codemode, 'spotify')
		expect(token).toBe('fresh-access-token')
		expect(requests).toHaveLength(1)
		const request = requests[0]
		const body = await request?.text()
		expect(request?.url).toBe('https://accounts.spotify.com/api/token')
		expect(request?.method).toBe('POST')
		expect(request?.headers.get('Content-Type')).toBe(
			'application/x-www-form-urlencoded',
		)
		expect(body).toContain('grant_type=refresh_token')
		expect(body).toContain(
			'refresh_token=%7B%7Bsecret%3AspotifyRefreshToken%7Cscope%3Duser%7D%7D',
		)
		expect(body).toContain('client_id=spotify-client-id-value')
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('refreshAccessToken includes client secret placeholder for confidential connectors', async () => {
	const codemode = createMockCodemode({
		connector: {
			name: 'linear',
			tokenUrl: 'https://api.linear.app/oauth/token',
			apiBaseUrl: 'https://api.linear.app',
			flow: 'confidential',
			clientIdValueName: 'linear-client-id',
			clientSecretSecretName: 'linearClientSecret',
			accessTokenSecretName: 'linearAccessToken',
			refreshTokenSecretName: 'linearRefreshToken',
			requiredHosts: ['api.linear.app'],
		},
	}) as unknown as CodemodeUtilsNamespace
	const requests: Array<Request> = []
	const originalFetch = globalThis.fetch

	globalThis.fetch = async (input, init) => {
		requests.push(new Request(input, init))
		return Response.json({ access_token: 'linear-token' })
	}

	try {
		await refreshAccessToken(codemode, 'linear')
		const body = await requests[0]?.text()
		expect(body).toContain(
			'client_secret=%7B%7Bsecret%3AlinearClientSecret%7Cscope%3Duser%7D%7D',
		)
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('createAuthenticatedFetch resolves relative URLs against apiBaseUrl and injects bearer token', async () => {
	const codemode = createMockCodemode() as unknown as CodemodeUtilsNamespace
	const requests: Array<Request> = []
	const originalFetch = globalThis.fetch

	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init)
		requests.push(request)
		if (requests.length === 1) {
			return Response.json({ access_token: 'fresh-access-token' })
		}
		return Response.json({ ok: true })
	}

	try {
		const authFetch = await createAuthenticatedFetch(codemode, 'spotify')
		const response = await authFetch('/me/player')
		expect(response.ok).toBe(true)
		expect(requests).toHaveLength(2)
		const apiRequest = requests[1]
		expect(apiRequest?.url).toBe('https://api.spotify.com/v1/me/player')
		expect(apiRequest?.headers.get('Authorization')).toBe(
			'Bearer fresh-access-token',
		)
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('createCodemodeUtils binds helper methods to codemode', async () => {
	const codemode = createMockCodemode() as unknown as CodemodeUtilsNamespace
	const requests: Array<Request> = []
	const originalFetch = globalThis.fetch

	globalThis.fetch = async (input, init) => {
		requests.push(new Request(input, init))
		return Response.json({ access_token: 'bound-token' })
	}

	try {
		const utils = createCodemodeUtils(codemode)
		const token = await utils.refreshAccessToken('spotify')
		expect(token).toBe('bound-token')
		expect(requests).toHaveLength(1)
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('refreshAccessToken fails clearly when the connector is missing', async () => {
	const codemode = createMockCodemode({
		connector: null,
	}) as unknown as CodemodeUtilsNamespace
	await expect(refreshAccessToken(codemode, 'spotify')).rejects.toThrow(
		'Connector "spotify" was not found.',
	)
})

test('createAuthenticatedFetch rejects relative URLs without apiBaseUrl', async () => {
	const codemode = createMockCodemode({
		connector: {
			name: 'spotify',
			tokenUrl: 'https://accounts.spotify.com/api/token',
			apiBaseUrl: null,
			flow: 'pkce',
			clientIdValueName: 'spotify-client-id',
			clientSecretSecretName: null,
			accessTokenSecretName: 'spotifyAccessToken',
			refreshTokenSecretName: 'spotifyRefreshToken',
			requiredHosts: ['accounts.spotify.com'],
		},
	}) as unknown as CodemodeUtilsNamespace
	const originalFetch = globalThis.fetch

	globalThis.fetch = async () =>
		Response.json({ access_token: 'fresh-access-token' })

	try {
		const authFetch = await createAuthenticatedFetch(codemode, 'spotify')
		await expect(authFetch('/me/player')).rejects.toThrow(
			'Connector "spotify" does not define apiBaseUrl for relative requests.',
		)
	} finally {
		globalThis.fetch = originalFetch
	}
})
