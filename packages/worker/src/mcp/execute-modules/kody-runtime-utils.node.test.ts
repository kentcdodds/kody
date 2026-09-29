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
	type secretHeaders,
} from './kody-runtime-utils.ts'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'

type SandboxHelpers = {
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

type TestIntegration = {
	name: string
	tokenUrl: string
	apiBaseUrl: string
	flow: 'pkce' | 'confidential'
	clientId: string
	requiredHosts: Array<string>
	platform?: boolean
}

const spotifyIntegration: TestIntegration = {
	name: 'spotify',
	tokenUrl: 'https://accounts.spotify.test/api/token',
	apiBaseUrl: 'https://api.spotify.test/v1',
	flow: 'pkce',
	clientId: 'spotify-client-id',
	requiredHosts: ['api.spotify.test'],
}

const githubPlatformIntegration: TestIntegration = {
	name: 'github',
	tokenUrl: 'https://github.test/login/oauth/access_token',
	apiBaseUrl: 'https://api.github.test',
	flow: 'confidential',
	clientId: 'platform-github-client-id',
	requiredHosts: ['api.github.test'],
	platform: true,
}

function createKody(integration: TestIntegration) {
	const tokenRefreshCalls: Array<CapabilityArgs> = []
	const kody = {
		async integrationGet(args: CapabilityArgs) {
			expect(args.name).toBe(integration.name)
			return { integration }
		},
		async integrationTokenRefresh(args: CapabilityArgs) {
			tokenRefreshCalls.push(args)
			return {
				ok: true,
				refreshedAt: new Date().toISOString(),
				refreshTokenRotated: false,
			}
		},
	} satisfies KodyNamespace
	return { kody, tokenRefreshCalls }
}

function createFetchInterceptor(options: {
	fetchCalls: Array<Request>
	apiErrors: Array<Error>
	apiResponses: Array<ApiResponseSpec>
}) {
	// MSW HttpResponse bodies hang on response.body.cancel(), which
	// createAuthenticatedFetch uses during 401 retry. Native Response
	// objects from FetchInterceptor avoid that Node/Vitest issue.
	const apiErrors = [...options.apiErrors]
	const apiResponses = [...options.apiResponses]
	const interceptor = new FetchInterceptor()
	interceptor.on('request', ({ request, controller }) => {
		void (async () => {
			try {
				options.fetchCalls.push(request.clone())
				const apiError = apiErrors.shift()
				if (apiError) {
					controller.errorWith(apiError)
					return
				}
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

test('createAuthenticatedFetch uses placeholder auth and refreshes host-side on missing or expired tokens', async () => {
	const expired = [
		{ status: 401, body: { error: 'expired' } },
		{ status: 200, body: { ok: true } },
	]
	// Every attempt uses the placeholder header: the raw token never enters
	// the sandbox even on the post-refresh retry.
	const scenarios = [
		{
			label: 'stored token',
			integration: spotifyIntegration,
			path: '/me/playlists',
			init: { method: 'POST' },
			apiErrors: [],
			apiResponses: [],
			urls: ['https://api.spotify.test/v1/me/playlists'],
		},
		{
			label: 'missing token',
			integration: spotifyIntegration,
			path: '/me?market=US',
			apiErrors: [
				new Error('Integration "spotify" does not have a stored access token.'),
			],
			apiResponses: [],
			urls: Array(2).fill('https://api.spotify.test/v1/me?market=US'),
		},
		{
			label: 'expired token',
			integration: spotifyIntegration,
			path: '/me?market=US',
			apiErrors: [],
			apiResponses: expired,
			urls: Array(2).fill('https://api.spotify.test/v1/me?market=US'),
		},
		{
			label: 'expired platform token',
			integration: githubPlatformIntegration,
			path: '/user',
			apiErrors: [],
			apiResponses: expired,
			urls: Array(2).fill('https://api.github.test/user'),
		},
	]
	for (const scenario of scenarios) {
		const { name } = scenario.integration
		const fetchCalls: Array<Request> = []
		const { kody, tokenRefreshCalls } = createKody(scenario.integration)
		{
			using _interceptor = createFetchInterceptor({ fetchCalls, ...scenario })
			const authenticatedFetch = await createAuthenticatedFetch(kody, name)
			const response = await authenticatedFetch(scenario.path, scenario.init)
			expect(await response.json()).toEqual({ ok: true })
		}
		expect({
			label: scenario.label,
			tokenRefreshCalls,
			requests: fetchCalls.map((request) => [
				request.url,
				request.headers.get('authorization'),
			]),
		}).toEqual({
			label: scenario.label,
			tokenRefreshCalls: scenario.urls.length > 1 ? [{ name }] : [],
			requests: scenario.urls.map((url) => [
				url,
				`Bearer {{integration-token:${name}}}`,
			]),
		})
	}
})

test('createExecuteHelperPrelude exposes sandbox oauth and secret helper bindings', async () => {
	const prelude = createExecuteHelperPrelude()
	const createSandboxHelpers = new Function(
		'__kodyCallDispatcher',
		`${prelude}; return { createAuthenticatedFetch, secretHeaders, oauthClientCredentials };`,
	) as (
		dispatch: (name: string, args: CapabilityArgs) => Promise<unknown>,
	) => SandboxHelpers
	const dispatchFor = (kody: KodyNamespace) => {
		return async (name: string, args: CapabilityArgs) => {
			const tool = kody[name]
			if (typeof tool !== 'function') {
				throw new Error(`${name} is not available in this sandbox.`)
			}
			return await tool(args)
		}
	}

	const helpers = createSandboxHelpers(
		dispatchFor(createKody(spotifyIntegration).kody),
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
	// packageSecrets.get(...) opaque refs pass straight into secretHeaders.basic
	// without package code parsing the placeholder.
	expect(
		helpers.secretHeaders.basic({
			usernameSecret: '{{secret:paypalClientId|scope=user}}',
			passwordSecret: '{{secret:paypalClientSecret|scope=user}}',
		}),
	).toBe(
		'{{secret-basic:username=paypalClientId,password=paypalClientSecret|scope=user}}',
	)

	const platform = createKody(githubPlatformIntegration)
	const platformCalls: Array<string> = []
	const platformHelpers = createSandboxHelpers(async (name, args) => {
		platformCalls.push(name)
		return await dispatchFor(platform.kody)(name, args)
	})
	expect(typeof platformHelpers.createAuthenticatedFetch).toBe('function')
	await platformHelpers.createAuthenticatedFetch('github')
	expect(platformCalls).toEqual(['integrationGet'])

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
