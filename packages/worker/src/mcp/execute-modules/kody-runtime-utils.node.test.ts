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

type SecretSetManyCall = {
	secrets: Array<{
		name: string
		value?: string
		scope: string
	}>
	assertOnly?: boolean
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
		onSecretSetMany?: (call: SecretSetManyCall) => void | Promise<void>
	} = {},
) {
	const secretSetManyCalls: Array<SecretSetManyCall> = []
	const tokenRefreshCalls: Array<CapabilityArgs> = []
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
		async secret_set_many(args: CapabilityArgs) {
			const call = args as SecretSetManyCall
			secretSetManyCalls.push(call)
			await options.onSecretSetMany?.(call)
			if (!call.assertOnly) {
				for (const secret of call.secrets) {
					if (typeof secret.value === 'string') {
						storedSecrets.set(secret.name, secret.value)
					}
				}
			}
			return {
				ok: true,
				assertOnly: Boolean(call.assertOnly),
				secrets: call.assertOnly
					? []
					: call.secrets.map((secret) => ({
							name: secret.name,
							scope: secret.scope,
						})),
			}
		},
	} satisfies KodyNamespace

	return { kody, secretSetManyCalls, tokenRefreshCalls, storedSecrets }
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
	const { kody: rotatedKody, secretSetManyCalls: rotatedSecretSetManyCalls } =
		createKody()
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
		const rotatedAccessToken = await refreshAccessToken(rotatedKody, 'spotify')
		expect(rotatedAccessToken).toBe('new-access-token')
	}
	expect(rotatedSecretSetManyCalls).toEqual([
		{
			secrets: [
				{ name: 'spotifyRefreshToken', scope: 'user' },
				{ name: 'spotifyAccessToken', scope: 'user' },
			],
			assertOnly: true,
		},
		{
			secrets: [
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
			],
		},
	])
	expect(rotatedRefreshFetchCalls).toHaveLength(1)
	expect(rotatedRefreshFetchCalls[0]?.method).toBe('POST')
	const rotatedRefreshBody = await rotatedRefreshFetchCalls[0]?.text()
	expect(rotatedRefreshBody).toContain(
		'refresh_token=%7B%7Bsecret%3AspotifyRefreshToken%7Cscope%3Duser%7D%7D',
	)
	expect(rotatedRefreshBody).toContain('client_id=spotify-client-id')
	expect(rotatedRefreshBody).not.toContain('client_secret=')

	const storedTokenFetchCalls: Array<Request> = []
	const {
		kody: storedTokenKody,
		secretSetManyCalls: storedSecretSetManyCalls,
	} = createKody()
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
	expect(storedSecretSetManyCalls).toEqual([])

	const missingTokenFetchCalls: Array<Request> = []
	const {
		kody: missingTokenKody,
		secretSetManyCalls: missingSecretSetManyCalls,
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
	expect(missingSecretSetManyCalls).toEqual([])
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
		secretSetManyCalls: expiredSecretSetManyCalls,
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
	expect(expiredSecretSetManyCalls).toEqual([])
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

test('token refresh asserts package grants before the provider request and never consumes the token on denial', async () => {
	const fetchCalls: Array<Request> = []
	const { kody, secretSetManyCalls, storedSecrets } = createKody(
		spotifyIntegration,
		{
			onSecretSetMany(call) {
				if (call.assertOnly) {
					throw new Error(
						'Secret "spotifyRefreshToken" is not allowed for package "@test/spotify".',
					)
				}
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
	expect(secretSetManyCalls).toEqual([
		{
			secrets: [
				{ name: 'spotifyRefreshToken', scope: 'user' },
				{ name: 'spotifyAccessToken', scope: 'user' },
			],
			assertOnly: true,
		},
	])
	expect(storedSecrets.size).toBe(0)
})

test('token refresh keeps prior secret state when the atomic persist fails after a rotated provider response', async () => {
	const fetchCalls: Array<Request> = []
	const { kody, secretSetManyCalls, storedSecrets } = createKody(
		spotifyIntegration,
		{
			onSecretSetMany(call) {
				if (call.assertOnly) return
				throw new Error('simulated second-write failure')
			},
		},
	)
	storedSecrets.set('spotifyRefreshToken', 'old-refresh-token')
	storedSecrets.set('spotifyAccessToken', 'old-access-token')
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
		await expect(refreshAccessToken(kody, 'spotify')).rejects.toThrow(
			'simulated second-write failure',
		)
	}
	expect(fetchCalls).toHaveLength(1)
	expect(secretSetManyCalls).toEqual([
		{
			secrets: [
				{ name: 'spotifyRefreshToken', scope: 'user' },
				{ name: 'spotifyAccessToken', scope: 'user' },
			],
			assertOnly: true,
		},
		{
			secrets: [
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
			],
		},
	])
	// Atomic persist failed as one unit: neither rotated secret was committed.
	expect(Object.fromEntries(storedSecrets)).toEqual({
		spotifyRefreshToken: 'old-refresh-token',
		spotifyAccessToken: 'old-access-token',
	})
})

test('successful token rotation persists refresh then access secrets together', async () => {
	const fetchCalls: Array<Request> = []
	const { kody, secretSetManyCalls, storedSecrets } = createKody()
	storedSecrets.set('spotifyRefreshToken', 'old-refresh-token')
	storedSecrets.set('spotifyAccessToken', 'old-access-token')
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
		const accessToken = await refreshAccessToken(kody, 'spotify')
		expect(accessToken).toBe('new-access-token')
	}
	expect(fetchCalls).toHaveLength(1)
	expect(secretSetManyCalls[1]?.secrets.map((secret) => secret.name)).toEqual([
		'spotifyRefreshToken',
		'spotifyAccessToken',
	])
	expect(Object.fromEntries(storedSecrets)).toEqual({
		spotifyRefreshToken: 'new-refresh-token',
		spotifyAccessToken: 'new-access-token',
	})
})

test('createExecuteHelperPrelude exposes sandbox helpers for token refresh, authenticated fetch, secrets, and client credentials', async () => {
	const prelude = createExecuteHelperPrelude()
	const createSandboxHelpers = new Function(
		'kody',
		`${prelude}; return { refreshAccessToken, createAuthenticatedFetch, secretHeaders, oauthClientCredentials };`,
	) as (kodyNamespace: KodyNamespace) => SandboxHelpers

	const fetchCalls: Array<Request> = []
	const { kody, secretSetManyCalls } = createKody()
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
		const helpers = createSandboxHelpers(kody)
		const accessToken = await helpers.refreshAccessToken('spotify')
		const authenticatedFetch = await helpers.createAuthenticatedFetch('spotify')
		await authenticatedFetch('/me')
		expect(accessToken).toBe('new-access-token')
	}
	expect(secretSetManyCalls).toEqual([
		{
			secrets: [
				{ name: 'spotifyRefreshToken', scope: 'user' },
				{ name: 'spotifyAccessToken', scope: 'user' },
			],
			assertOnly: true,
		},
		{
			secrets: [
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
			],
		},
	])
	expect(fetchCalls).toHaveLength(2)
	expect(fetchCalls[1]?.headers.get('authorization')).toBe(
		'Bearer {{secret:spotifyAccessToken|scope=user}}',
	)

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
		async secret_set_many() {
			throw new Error(
				'platform refresh must never persist secrets from the sandbox',
			)
		},
	} satisfies KodyNamespace
	return { kody, tokenRefreshCalls }
}

test('refreshAccessToken refuses platform integrations instead of exposing a raw token', async () => {
	const { kody, tokenRefreshCalls } = createPlatformKody()
	await expect(refreshAccessToken(kody, 'github')).rejects.toThrow(
		'raw tokens are never exposed to sandboxed code',
	)
	expect(tokenRefreshCalls).toEqual([])
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

test('prelude user-lane createAuthenticatedFetch refreshes host-side on 401', async () => {
	const prelude = createExecuteHelperPrelude()
	const createSandboxHelpers = new Function(
		'kody',
		`${prelude}; return { refreshAccessToken, createAuthenticatedFetch, secretHeaders, oauthClientCredentials };`,
	) as (kodyNamespace: KodyNamespace) => SandboxHelpers

	const fetchCalls: Array<Request> = []
	const { kody, secretSetManyCalls, tokenRefreshCalls } = createKody()
	const helpers = createSandboxHelpers(kody)
	{
		using _spotifyFetch = createSpotifyFetchInterceptor({
			tokenPayload: { access_token: 'new-access-token' },
			fetchCalls,
			apiResponses: [
				{ status: 401, body: { error: 'expired' } },
				{ status: 200, body: { ok: true } },
			],
		})
		const authenticatedFetch = await helpers.createAuthenticatedFetch('spotify')
		const response = await authenticatedFetch('https://api.spotify.test/v1/me')
		expect(await response.json()).toEqual({ ok: true })
	}
	expect(tokenRefreshCalls).toEqual([{ name: 'spotify' }])
	expect(secretSetManyCalls).toEqual([])
	expect(fetchCalls).toHaveLength(2)
	expect(fetchCalls[0]?.headers.get('authorization')).toBe(
		'Bearer {{secret:spotifyAccessToken|scope=user}}',
	)
	expect(fetchCalls[1]?.headers.get('authorization')).toBe(
		'Bearer {{secret:spotifyAccessToken|scope=user}}',
	)
})

test('prelude platform helpers mirror the host-side refresh behavior', async () => {
	const prelude = createExecuteHelperPrelude()
	const createSandboxHelpers = new Function(
		'kody',
		`${prelude}; return { refreshAccessToken, createAuthenticatedFetch, secretHeaders, oauthClientCredentials };`,
	) as (kodyNamespace: KodyNamespace) => SandboxHelpers

	const { kody, tokenRefreshCalls } = createPlatformKody()
	const helpers = createSandboxHelpers(kody)
	await expect(helpers.refreshAccessToken('github')).rejects.toThrow(
		'raw tokens are never exposed to sandboxed code',
	)

	const fetchCalls: Array<Request> = []
	{
		using _interceptor = createGithubPlatformFetchInterceptor({
			fetchCalls,
			apiResponses: [
				{ status: 401, body: { error: 'expired' } },
				{ status: 200, body: { ok: true } },
			],
		})
		const authenticatedFetch = await helpers.createAuthenticatedFetch('github')
		const response = await authenticatedFetch('/user')
		expect(await response.json()).toEqual({ ok: true })
	}
	expect(tokenRefreshCalls).toEqual([{ name: 'github' }])
	expect(fetchCalls).toHaveLength(2)
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

test('confidential-flow token refresh includes inline client id and client secret placeholder', async () => {
	const fetchCalls: Array<Request> = []
	const { kody, secretSetManyCalls } = createKody(githubConfidentialIntegration)
	{
		using _server = createMswNodeServer([
			http.post(githubConfidentialIntegration.tokenUrl, async ({ request }) => {
				fetchCalls.push(request.clone())
				return HttpResponse.json({ access_token: 'new-github-access' })
			}),
		])
		const accessToken = await refreshAccessToken(kody, 'github')
		expect(accessToken).toBe('new-github-access')
	}
	expect(secretSetManyCalls).toEqual([
		{
			secrets: [
				{ name: 'githubRefreshToken', scope: 'user' },
				{ name: 'githubAccessToken', scope: 'user' },
			],
			assertOnly: true,
		},
		{
			secrets: [
				{
					name: 'githubAccessToken',
					value: 'new-github-access',
					scope: 'user',
				},
			],
		},
	])
	expect(fetchCalls).toHaveLength(1)
	const body = await fetchCalls[0]?.text()
	expect(body).toContain('grant_type=refresh_token')
	expect(body).toContain('client_id=github-client-id')
	expect(body).toContain(
		'client_secret=%7B%7Bsecret%3AgithubClientSecret%7Cscope%3Duser%7D%7D',
	)
	expect(body).toContain(
		'refresh_token=%7B%7Bsecret%3AgithubRefreshToken%7Cscope%3Duser%7D%7D',
	)
})
