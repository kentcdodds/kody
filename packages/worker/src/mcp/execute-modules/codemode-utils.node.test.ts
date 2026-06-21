import { FetchInterceptor } from '@mswjs/interceptors/fetch'
import { expect, test } from 'vitest'
import { http, HttpResponse } from 'msw'
import {
	type CapabilityArgs,
	type CodemodeNamespace,
	type ExecuteRequestInput,
	createAuthenticatedFetch,
	createExecuteHelperPrelude,
	type oauthClientCredentials,
	refreshAccessToken,
	type secretHeaders,
} from './codemode-utils.ts'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'

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

function createCodemode() {
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

	return { codemode, secretSetCalls }
}

function createSpotifyHandlers(options: {
	tokenPayload: Record<string, unknown>
	fetchCalls: Array<Request>
	apiResponses?: Array<ApiResponseSpec>
}) {
	const apiResponses = [...(options.apiResponses ?? [])]
	return [
		http.post(spotifyIntegration.tokenUrl, async ({ request }) => {
			options.fetchCalls.push(request.clone())
			return HttpResponse.json(options.tokenPayload)
		}),
		http.all('https://api.spotify.test/v1/*', async ({ request }) => {
			options.fetchCalls.push(request.clone())
			const apiResponse = apiResponses.shift()
			if (apiResponse) {
				return HttpResponse.json(apiResponse.body, {
					status: apiResponse.status,
				})
			}
			return HttpResponse.json({ ok: true })
		}),
	]
}

type SpotifyFetchInterceptorOptions = {
	tokenPayload: Record<string, unknown>
	fetchCalls: Array<Request>
	apiErrors?: Array<Error>
	apiResponses?: Array<ApiResponseSpec>
}

function createSpotifyFetchInterceptor(
	options: SpotifyFetchInterceptorOptions,
) {
	// MSW HttpResponse bodies hang on response.body.cancel(), which
	// createAuthenticatedFetch uses during 401 retry. Native Response
	// objects from FetchInterceptor avoid that Node/Vitest issue.
	const apiErrors = [...(options.apiErrors ?? [])]
	const apiResponses = [...(options.apiResponses ?? [])]
	const interceptor = new FetchInterceptor()
	interceptor.on('request', ({ request, controller }) => {
		void (async () => {
			try {
				options.fetchCalls.push(request.clone())
				if (request.url === spotifyIntegration.tokenUrl) {
					await controller.respondWith(
						Response.json(options.tokenPayload, {
							headers: { 'content-type': 'application/json' },
						}),
					)
					return
				}
				const apiError = apiErrors.shift()
				if (apiError) {
					controller.errorWith(apiError)
					return
				}
				const apiResponse = apiResponses.shift()
				if (apiResponse) {
					await controller.respondWith(
						Response.json(apiResponse.body, {
							status: apiResponse.status,
							headers: { 'content-type': 'application/json' },
						}),
					)
					return
				}
				await controller.respondWith(
					Response.json(
						{ ok: true },
						{ headers: { 'content-type': 'application/json' } },
					),
				)
			} catch (error) {
				controller.errorWith(error)
			}
		})()
	})
	interceptor.apply()
	return {
		[Symbol.dispose]() {
			interceptor.dispose()
		},
	}
}

test('codemode oauth helpers refresh tokens, retry on missing or expired access tokens, and persist rotations', async () => {
	const rotatedRefreshFetchCalls: Array<Request> = []
	const { codemode: rotatedCodemode, secretSetCalls: rotatedSecretSetCalls } =
		createCodemode()
	{
		using _server = createMswNodeServer(
			createSpotifyHandlers({
				tokenPayload: {
					access_token: 'new-access-token',
					refresh_token: 'new-refresh-token',
				},
				fetchCalls: rotatedRefreshFetchCalls,
			}),
		)
		const rotatedAccessToken = await refreshAccessToken(
			rotatedCodemode,
			'spotify',
		)
		expect(rotatedAccessToken).toBe('new-access-token')
	}
	expect(rotatedSecretSetCalls).toEqual([
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
	expect(rotatedRefreshFetchCalls).toHaveLength(1)
	expect(rotatedRefreshFetchCalls[0]?.method).toBe('POST')
	expect(await rotatedRefreshFetchCalls[0]?.text()).toContain(
		'refresh_token=%7B%7Bsecret%3AspotifyRefreshToken%7Cscope%3Duser%7D%7D',
	)

	const storedTokenFetchCalls: Array<Request> = []
	const {
		codemode: storedTokenCodemode,
		secretSetCalls: storedSecretSetCalls,
	} = createCodemode()
	{
		using _server = createMswNodeServer(
			createSpotifyHandlers({
				tokenPayload: { access_token: 'refreshed-access-token' },
				fetchCalls: storedTokenFetchCalls,
			}),
		)
		const authenticatedFetch = await createAuthenticatedFetch(
			storedTokenCodemode,
			'spotify',
		)
		const storedTokenResponse = await authenticatedFetch('/me/playlists', {
			method: 'POST',
		})
		expect(await storedTokenResponse.json()).toEqual({ ok: true })
	}
	expect(storedTokenFetchCalls).toHaveLength(1)
	expect(storedTokenFetchCalls[0]?.url).toBe(
		'https://api.spotify.test/v1/me/playlists',
	)
	expect(storedTokenFetchCalls[0]?.headers.get('authorization')).toBe(
		'Bearer {{secret:spotifyAccessToken|scope=user}}',
	)
	expect(storedSecretSetCalls).toEqual([])

	const missingTokenFetchCalls: Array<Request> = []
	const {
		codemode: missingTokenCodemode,
		secretSetCalls: missingSecretSetCalls,
	} = createCodemode()
	{
		using _spotifyFetch = createSpotifyFetchInterceptor({
			tokenPayload: { access_token: 'new-access-token' },
			fetchCalls: missingTokenFetchCalls,
			apiErrors: [new Error('Secret "spotifyAccessToken" was not found.')],
		})
		const missingTokenFetch = await createAuthenticatedFetch(
			missingTokenCodemode,
			'spotify',
		)
		const missingTokenResponse = await missingTokenFetch('/me?market=US')
		expect(await missingTokenResponse.json()).toEqual({ ok: true })
	}
	expect(missingSecretSetCalls).toEqual([
		{
			name: 'spotifyAccessToken',
			value: 'new-access-token',
			scope: 'user',
		},
	])
	expect(missingTokenFetchCalls).toHaveLength(3)
	expect(missingTokenFetchCalls[0]?.headers.get('authorization')).toBe(
		'Bearer {{secret:spotifyAccessToken|scope=user}}',
	)
	expect(missingTokenFetchCalls[1]?.url).toBe(
		'https://accounts.spotify.test/api/token',
	)
	expect(missingTokenFetchCalls[2]?.headers.get('authorization')).toBe(
		'Bearer new-access-token',
	)

	const expiredTokenFetchCalls: Array<Request> = []
	const {
		codemode: expiredTokenCodemode,
		secretSetCalls: expiredSecretSetCalls,
	} = createCodemode()
	{
		using _spotifyFetch = createSpotifyFetchInterceptor({
			tokenPayload: { access_token: 'new-access-token' },
			fetchCalls: expiredTokenFetchCalls,
			apiResponses: [
				{ status: 401, body: { error: 'expired' } },
				{ status: 200, body: { ok: true } },
			],
		})
		const expiredTokenFetch = await createAuthenticatedFetch(
			expiredTokenCodemode,
			'spotify',
		)
		const expiredTokenResponse = await expiredTokenFetch('/me?market=US')
		expect(await expiredTokenResponse.json()).toEqual({ ok: true })
	}
	expect(expiredSecretSetCalls).toEqual([
		{
			name: 'spotifyAccessToken',
			value: 'new-access-token',
			scope: 'user',
		},
	])
	expect(expiredTokenFetchCalls).toHaveLength(3)
	expect(expiredTokenFetchCalls[0]?.url).toBe(
		'https://api.spotify.test/v1/me?market=US',
	)
	expect(expiredTokenFetchCalls[1]?.url).toBe(
		'https://accounts.spotify.test/api/token',
	)
	expect(expiredTokenFetchCalls[2]?.headers.get('authorization')).toBe(
		'Bearer new-access-token',
	)
})

test('createExecuteHelperPrelude exposes sandbox helpers for token refresh, authenticated fetch, secrets, and client credentials', async () => {
	const prelude = createExecuteHelperPrelude()
	const createSandboxHelpers = new Function(
		'codemode',
		`${prelude}; return { refreshAccessToken, createAuthenticatedFetch, secretHeaders, oauthClientCredentials };`,
	) as (codemodeNamespace: CodemodeNamespace) => SandboxHelpers

	const fetchCalls: Array<Request> = []
	const { codemode, secretSetCalls } = createCodemode()
	{
		using _server = createMswNodeServer(
			createSpotifyHandlers({
				tokenPayload: {
					access_token: 'new-access-token',
					refresh_token: 'new-refresh-token',
				},
				fetchCalls,
			}),
		)
		const helpers = createSandboxHelpers(codemode)
		const accessToken = await helpers.refreshAccessToken('spotify')
		const authenticatedFetch = await helpers.createAuthenticatedFetch('spotify')
		await authenticatedFetch('/me')
		expect(accessToken).toBe('new-access-token')
	}
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

	const helpers = createSandboxHelpers(createCodemode().codemode)
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
	{
		using _server = createMswNodeServer([
			http.post(
				'https://api-m.paypal.com/v1/oauth2/token',
				async ({ request }) => {
					clientCredentialsCalls.push(request.clone())
					return HttpResponse.json({
						access_token: 'paypal-access-token',
						token_type: 'Bearer',
					})
				},
			),
		])
		const tokenResponse = await helpers.oauthClientCredentials({
			tokenUrl: 'https://api-m.paypal.com/v1/oauth2/token',
			clientIdSecret: 'paypalClientId',
			clientSecretSecret: 'paypalClientSecret',
			scope: 'user',
			body: {
				scope: 'openid',
			},
		})
		expect(tokenResponse).toEqual({
			access_token: 'paypal-access-token',
			token_type: 'Bearer',
		})
	}
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
