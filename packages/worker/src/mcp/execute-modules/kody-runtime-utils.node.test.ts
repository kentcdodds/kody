import { FetchInterceptor } from '@mswjs/interceptors/fetch'
import { expect, test } from 'vitest'
import { http, HttpResponse } from 'msw'
import {
	type CapabilityArgs,
	type KodyNamespace,
	type ExecuteRequestInput,
	createAuthenticatedFetch,
	createExecuteHelperPrelude,
	type oauthClientCredentials,
	refreshAccessToken,
	type secretHeaders,
} from './kody-runtime-utils.ts'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'

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
	clientId: 'spotify-client-id',
	clientSecretSecretName: null,
	accessTokenSecretName: 'spotifyAccessToken',
	refreshTokenSecretName: 'spotifyRefreshToken',
	requiredHosts: ['api.spotify.test'],
}

const githubConfidentialIntegration = {
	name: 'github',
	tokenUrl: 'https://github.test/login/oauth/access_token',
	apiBaseUrl: 'https://api.github.test',
	flow: 'confidential' as const,
	clientId: 'github-client-id',
	clientSecretSecretName: 'githubClientSecret',
	accessTokenSecretName: 'githubAccessToken',
	refreshTokenSecretName: 'githubRefreshToken',
	requiredHosts: ['api.github.test'],
}

function createKody(
	integration = spotifyIntegration,
	options: {
		accessToken?: string
		onRefreshAccessToken?: (args: CapabilityArgs) => void | Promise<void>
	} = {},
) {
	const tokenRefreshCalls: Array<CapabilityArgs> = []
	const refreshAccessTokenCalls: Array<CapabilityArgs> = []
	const storedSecrets = new Map<string, string>()
	const kody = {
		async integration_get(args: CapabilityArgs) {
			const name = args.name
			expect(name).toBe(integration.name)
			return { integration }
		},
		async integration_token_refresh(args: CapabilityArgs) {
			tokenRefreshCalls.push(args)
			return {
				ok: true,
				refreshedAt: new Date().toISOString(),
				refreshTokenRotated: false,
			}
		},
		async integration_refresh_access_token(args: CapabilityArgs) {
			refreshAccessTokenCalls.push(args)
			await options.onRefreshAccessToken?.(args)
			const accessToken = options.accessToken ?? 'new-access-token'
			storedSecrets.set(integration.accessTokenSecretName, accessToken)
			return {
				accessToken,
				refreshedAt: new Date().toISOString(),
				refreshTokenRotated: false,
			}
		},
	} satisfies KodyNamespace

	return {
		kody,
		tokenRefreshCalls,
		refreshAccessTokenCalls,
		storedSecrets,
	}
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

test('kody oauth helpers refresh tokens, retry on missing or expired access tokens, and persist rotations', async () => {
	const rotatedRefreshFetchCalls: Array<Request> = []
	const {
		kody: rotatedKody,
		refreshAccessTokenCalls,
		storedSecrets: rotatedStoredSecrets,
	} = createKody(spotifyIntegration, { accessToken: 'new-access-token' })
	{
		using _server = createMswNodeServer(
			createSpotifyHandlers({
				tokenPayload: {
					access_token: 'should-not-be-used-in-sandbox',
					refresh_token: 'should-not-be-used-in-sandbox',
				},
				fetchCalls: rotatedRefreshFetchCalls,
			}),
		)
		const rotatedAccessToken = await refreshAccessToken(rotatedKody, 'spotify')
		expect(rotatedAccessToken).toBe('new-access-token')
	}
	expect(refreshAccessTokenCalls).toEqual([{ name: 'spotify' }])
	expect(rotatedRefreshFetchCalls).toEqual([])
	expect(Object.fromEntries(rotatedStoredSecrets)).toEqual({
		spotifyAccessToken: 'new-access-token',
	})

	const storedTokenFetchCalls: Array<Request> = []
	const { kody: storedTokenKody, tokenRefreshCalls: storedTokenRefreshCalls } =
		createKody()
	{
		using _server = createMswNodeServer(
			createSpotifyHandlers({
				tokenPayload: { access_token: 'refreshed-access-token' },
				fetchCalls: storedTokenFetchCalls,
			}),
		)
		const authenticatedFetch = await createAuthenticatedFetch(
			storedTokenKody,
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
	expect(storedTokenRefreshCalls).toEqual([])

	const missingTokenFetchCalls: Array<Request> = []
	const {
		kody: missingTokenKody,
		tokenRefreshCalls: missingTokenRefreshCalls,
	} = createKody()
	{
		using _spotifyFetch = createSpotifyFetchInterceptor({
			tokenPayload: { access_token: 'new-access-token' },
			fetchCalls: missingTokenFetchCalls,
			apiErrors: [new Error('Secret "spotifyAccessToken" was not found.')],
		})
		const missingTokenFetch = await createAuthenticatedFetch(
			missingTokenKody,
			'spotify',
		)
		const missingTokenResponse = await missingTokenFetch('/me?market=US')
		expect(await missingTokenResponse.json()).toEqual({ ok: true })
	}
	expect(missingTokenRefreshCalls).toEqual([{ name: 'spotify' }])
	expect(missingTokenFetchCalls).toHaveLength(2)
	expect(missingTokenFetchCalls[0]?.headers.get('authorization')).toBe(
		'Bearer {{secret:spotifyAccessToken|scope=user}}',
	)
	expect(missingTokenFetchCalls[1]?.headers.get('authorization')).toBe(
		'Bearer {{secret:spotifyAccessToken|scope=user}}',
	)

	const expiredTokenFetchCalls: Array<Request> = []
	const {
		kody: expiredTokenKody,
		tokenRefreshCalls: expiredTokenRefreshCalls,
	} = createKody()
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
			expiredTokenKody,
			'spotify',
		)
		const expiredTokenResponse = await expiredTokenFetch('/me?market=US')
		expect(await expiredTokenResponse.json()).toEqual({ ok: true })
	}
	expect(expiredTokenRefreshCalls).toEqual([{ name: 'spotify' }])
	expect(expiredTokenFetchCalls).toHaveLength(2)
	expect(expiredTokenFetchCalls[0]?.url).toBe(
		'https://api.spotify.test/v1/me?market=US',
	)
	expect(expiredTokenFetchCalls[0]?.headers.get('authorization')).toBe(
		'Bearer {{secret:spotifyAccessToken|scope=user}}',
	)
	expect(expiredTokenFetchCalls[1]?.headers.get('authorization')).toBe(
		'Bearer {{secret:spotifyAccessToken|scope=user}}',
	)
})

test('refreshAccessToken forwards host-side use denials and never exchanges tokens in the sandbox', async () => {
	const fetchCalls: Array<Request> = []
	const { kody, refreshAccessTokenCalls, storedSecrets } = createKody(
		spotifyIntegration,
		{
			onRefreshAccessToken() {
				throw new Error(
					'Secret "spotifyRefreshToken" is not allowed for package "@test/spotify".',
				)
			},
		},
	)
	{
		using _server = createMswNodeServer(
			createSpotifyHandlers({
				tokenPayload: {
					access_token: 'should-not-be-issued',
					refresh_token: 'should-not-be-issued',
				},
				fetchCalls,
			}),
		)
		await expect(refreshAccessToken(kody, 'spotify')).rejects.toThrow(
			'Secret "spotifyRefreshToken" is not allowed for package "@test/spotify".',
		)
	}
	expect(fetchCalls).toEqual([])
	expect(refreshAccessTokenCalls).toEqual([{ name: 'spotify' }])
	expect(storedSecrets.size).toBe(0)
})

test('createExecuteHelperPrelude exposes sandbox oauth and secret helper bindings', async () => {
	const prelude = createExecuteHelperPrelude()
	const createSandboxHelpers = new Function(
		'kody',
		`${prelude}; return { refreshAccessToken, createAuthenticatedFetch, secretHeaders, oauthClientCredentials };`,
	) as (kodyNamespace: KodyNamespace) => SandboxHelpers

	const helpers = createSandboxHelpers(createKody().kody)
	expect(
		helpers.secretHeaders.basic({
			usernameSecret: 'paypalClientId',
			passwordSecret: 'paypalClientSecret',
			scope: 'user',
		}),
	).toBe(
		'{{secret-basic:username=paypalClientId,password=paypalClientSecret|scope=user}}',
	)

	const platformHelpers = createSandboxHelpers(createPlatformKody().kody)
	await expect(platformHelpers.refreshAccessToken('github')).rejects.toThrow(
		'raw tokens are never exposed to sandboxed code',
	)
	expect(typeof platformHelpers.createAuthenticatedFetch).toBe('function')

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
	expect(clientCredentialsCalls[0]?.headers.get('authorization')).toBe(
		'{{secret-basic:username=paypalClientId,password=paypalClientSecret|scope=user}}',
	)
})

const githubPlatformIntegration = {
	name: 'github',
	tokenUrl: 'https://github.test/login/oauth/access_token',
	apiBaseUrl: 'https://api.github.test',
	flow: 'confidential' as const,
	clientId: 'platform-github-client-id',
	clientSecretSecretName: null,
	accessTokenSecretName: 'githubAccessToken',
	refreshTokenSecretName: 'githubRefreshToken',
	requiredHosts: ['api.github.test'],
	platform: true,
}

function createPlatformKody() {
	const tokenRefreshCalls: Array<CapabilityArgs> = []
	const refreshAccessTokenCalls: Array<CapabilityArgs> = []
	const kody = {
		async integration_get(args: CapabilityArgs) {
			expect(args.name).toBe(githubPlatformIntegration.name)
			return { integration: githubPlatformIntegration }
		},
		async integration_token_refresh(args: CapabilityArgs) {
			tokenRefreshCalls.push(args)
			return {
				ok: true,
				refreshedAt: new Date().toISOString(),
				refreshTokenRotated: false,
			}
		},
		async integration_refresh_access_token(args: CapabilityArgs) {
			refreshAccessTokenCalls.push(args)
			throw new Error(
				'platform refresh must never materialize a raw access token',
			)
		},
	} satisfies KodyNamespace
	return { kody, tokenRefreshCalls, refreshAccessTokenCalls }
}

test('refreshAccessToken refuses platform integrations instead of exposing a raw token', async () => {
	const { kody, tokenRefreshCalls, refreshAccessTokenCalls } =
		createPlatformKody()
	await expect(refreshAccessToken(kody, 'github')).rejects.toThrow(
		'raw tokens are never exposed to sandboxed code',
	)
	expect(tokenRefreshCalls).toEqual([])
	expect(refreshAccessTokenCalls).toEqual([])
})

test('createAuthenticatedFetch refreshes platform integrations host-side and retries with a placeholder header', async () => {
	const fetchCalls: Array<Request> = []
	const { kody, tokenRefreshCalls } = createPlatformKody()
	{
		using _interceptor = createGithubPlatformFetchInterceptor({
			fetchCalls,
			apiResponses: [
				{ status: 401, body: { error: 'expired' } },
				{ status: 200, body: { ok: true } },
			],
		})
		const authenticatedFetch = await createAuthenticatedFetch(kody, 'github')
		const response = await authenticatedFetch('/user')
		expect(await response.json()).toEqual({ ok: true })
	}
	expect(tokenRefreshCalls).toEqual([{ name: 'github' }])
	expect(fetchCalls).toHaveLength(2)
	// Both attempts use the placeholder header: the raw token never enters
	// the sandbox even on the post-refresh retry.
	expect(fetchCalls[0]?.headers.get('authorization')).toBe(
		'Bearer {{secret:githubAccessToken|scope=user}}',
	)
	expect(fetchCalls[1]?.headers.get('authorization')).toBe(
		'Bearer {{secret:githubAccessToken|scope=user}}',
	)
})

function createGithubPlatformFetchInterceptor(options: {
	fetchCalls: Array<Request>
	apiResponses: Array<ApiResponseSpec>
}) {
	const apiResponses = [...options.apiResponses]
	const interceptor = new FetchInterceptor()
	interceptor.on('request', ({ request, controller }) => {
		void (async () => {
			try {
				options.fetchCalls.push(request.clone())
				const apiResponse = apiResponses.shift()
				await controller.respondWith(
					Response.json(apiResponse?.body ?? { ok: true }, {
						status: apiResponse?.status ?? 200,
						headers: { 'content-type': 'application/json' },
					}),
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

test('confidential-flow refreshAccessToken still delegates persist to the host helper', async () => {
	const fetchCalls: Array<Request> = []
	const { kody, refreshAccessTokenCalls } = createKody(
		githubConfidentialIntegration,
		{ accessToken: 'new-github-access' },
	)
	{
		using _server = createMswNodeServer([
			http.post(githubConfidentialIntegration.tokenUrl, async ({ request }) => {
				fetchCalls.push(request.clone())
				return HttpResponse.json({ access_token: 'should-not-be-used' })
			}),
		])
		const accessToken = await refreshAccessToken(kody, 'github')
		expect(accessToken).toBe('new-github-access')
	}
	expect(refreshAccessTokenCalls).toEqual([{ name: 'github' }])
	expect(fetchCalls).toEqual([])
})

test('refreshAccessToken throws when the host helper capability is missing', async () => {
	const { kody } = createKody(githubConfidentialIntegration)
	const namespace = {
		integration_get: kody.integration_get,
		integration_token_refresh: kody.integration_token_refresh,
	}
	await expect(refreshAccessToken(namespace, 'github')).rejects.toThrow(
		'kody.integration_refresh_access_token is not available in this sandbox.',
	)
})

test('refreshAccessToken throws when the host helper returns no access token', async () => {
	const { kody } = createKody(githubConfidentialIntegration, {
		accessToken: '',
	})
	await expect(refreshAccessToken(kody, 'github')).rejects.toThrow(
		'Host-side token refresh for integration "github" did not return an access token.',
	)
})
