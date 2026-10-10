import { auth } from '@modelcontextprotocol/sdk/client/auth.js'
import { expect, test } from 'vitest'
import { createMcpClientOAuthProvider } from './client-id-metadata.ts'
import {
	describeMcpOAuthClientRegistrationError,
	normalizeMcpPreRegisteredOAuthClientInput,
	parseSealedMcpPreRegisteredOAuthClient,
} from './preregistered-oauth-client.ts'

const callbackUrl = 'https://kody.test/account/mcp-servers/oauth/callback'
const serverUrl = 'https://mcp.github.example/mcp'
const authServer = 'https://github.example'
const clientId = 'github-app-client'
const clientSecret = 'gh-client-secret-do-not-leak'

function createMemoryStorage() {
	const values = new Map<string, unknown>()
	const storage = {
		put: async (key: string | Record<string, unknown>, value?: unknown) => {
			if (typeof key === 'string') values.set(key, value)
			else for (const [k, v] of Object.entries(key)) values.set(k, v)
		},
		get: async (key: string) => values.get(key),
		delete: async (key: string | Array<string>) => {
			for (const item of Array.isArray(key) ? key : [key]) values.delete(item)
		},
		list: async ({ prefix }: { prefix?: string } = {}) =>
			new Map(
				[...values.entries()].filter(([key]) =>
					prefix ? key.startsWith(prefix) : true,
				),
			),
	} as unknown as DurableObjectStorage
	return { storage, values }
}

/**
 * An authorization server like GitHub's: no `registration_endpoint`, no
 * CIMD, and a token endpoint that requires the client secret.
 */
function createGitHubLikeAuthServer() {
	const tokenRequests: Array<{ authorization: string | null; body: string }> =
		[]
	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), {
			status,
			headers: { 'Content-Type': 'application/json' },
		})
	const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(input, init)
		const url = new URL(request.url)
		if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
			return json({ resource: serverUrl, authorization_servers: [authServer] })
		}
		if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
			return json({
				issuer: authServer,
				authorization_endpoint: `${authServer}/login/oauth/authorize`,
				token_endpoint: `${authServer}/login/oauth/access_token`,
				response_types_supported: ['code'],
				code_challenge_methods_supported: ['S256'],
				token_endpoint_auth_methods_supported: ['client_secret_post'],
			})
		}
		if (url.pathname === '/login/oauth/access_token') {
			const body = await request.text()
			tokenRequests.push({
				authorization: request.headers.get('Authorization'),
				body,
			})
			const params = new URLSearchParams(body)
			if (
				params.get('client_id') !== clientId ||
				params.get('client_secret') !== clientSecret
			) {
				return json({ error: 'invalid_client' }, 401)
			}
			return json({ access_token: 'gh-access', token_type: 'Bearer' })
		}
		return new Response('not found', { status: 404 })
	}
	return { fetchFn, tokenRequests }
}

function makeProvider(
	storage: DurableObjectStorage,
	preRegistered: { client_id: string; client_secret: string } | null,
) {
	const provider = createMcpClientOAuthProvider(storage, callbackUrl, {
		resolvePreRegisteredClient: async (serverId) =>
			serverId === 'server-gh' ? preRegistered : null,
	})
	provider.serverId = 'server-gh'
	return provider
}

test('a pre-registered client authorizes where neither CIMD nor DCR exists, and its secret only reaches the token endpoint', async () => {
	const { storage, values } = createMemoryStorage()
	const { fetchFn, tokenRequests } = createGitHubLikeAuthServer()
	const provider = makeProvider(storage, {
		client_id: clientId,
		client_secret: clientSecret,
	})

	expect(await auth(provider, { serverUrl, fetchFn })).toBe('REDIRECT')
	const authorizationUrl = new URL(provider.authUrl ?? '')
	expect(authorizationUrl.origin).toBe(authServer)
	expect(authorizationUrl.searchParams.get('client_id')).toBe(clientId)
	expect(authorizationUrl.href).not.toContain(clientSecret)
	expect(provider.clientId).toBe(clientId)

	const state = authorizationUrl.searchParams.get('state') ?? ''
	expect(await provider.checkState(state)).toMatchObject({ valid: true })
	expect(
		await auth(provider, { serverUrl, authorizationCode: 'code-1', fetchFn }),
	).toBe('AUTHORIZED')
	expect(tokenRequests).toHaveLength(1)
	expect(new URLSearchParams(tokenRequests[0]?.body).get('client_secret')).toBe(
		clientSecret,
	)
	expect(await provider.tokens()).toMatchObject({ access_token: 'gh-access' })

	const stored = JSON.stringify([...values.entries()])
	expect(stored).toContain(clientId)
	expect(stored).not.toContain(clientSecret)
})

test('without a pre-registered client the same server fails with guidance to configure one', async () => {
	const { storage, values } = createMemoryStorage()
	const { fetchFn, tokenRequests } = createGitHubLikeAuthServer()
	const provider = makeProvider(storage, null)

	const failure = await auth(provider, { serverUrl, fetchFn }).then(
		() => null,
		(error: unknown) => error,
	)
	expect(failure).toBeInstanceOf(Error)
	const message = describeMcpOAuthClientRegistrationError(
		(failure as Error).message,
	)
	expect(message).toMatch(
		/neither Client ID Metadata Documents nor dynamic client registration/,
	)
	expect(message).toMatch(/pre-registered OAuth client/)
	expect(tokenRequests).toHaveLength(0)
	expect([...values.keys()].some((key) => key.endsWith('/client_info/'))).toBe(
		false,
	)
	expect(describeMcpOAuthClientRegistrationError('socket hang up')).toBe(
		'socket hang up',
	)
})

test('client registrations for other ids still save normally', async () => {
	const { storage, values } = createMemoryStorage()
	const provider = makeProvider(storage, {
		client_id: clientId,
		client_secret: clientSecret,
	})
	await provider.saveClientInformation({
		client_id: clientId,
		issuer: authServer,
	})
	expect(values.size).toBe(0)
	await provider.saveClientInformation({ client_id: 'dcr-client' })
	expect([...values.keys()]).toEqual([
		'/Kody/server-gh/dcr-client/client_info/',
	])
})

test('settings input is trimmed and validated, and only well-formed sealed records parse', () => {
	expect(
		normalizeMcpPreRegisteredOAuthClientInput({
			clientId: '  Iv1.abc  ',
			clientSecret: ' secret ',
		}),
	).toEqual({ ok: true, clientId: 'Iv1.abc', clientSecret: 'secret' })
	expect(
		normalizeMcpPreRegisteredOAuthClientInput({
			clientId: '',
			clientSecret: 'x',
		}),
	).toEqual({ ok: false, error: 'Client ID is required.' })
	expect(
		normalizeMcpPreRegisteredOAuthClientInput({
			clientId: 'x',
			clientSecret: 7,
		}),
	).toEqual({ ok: false, error: 'Client secret is required.' })
	expect(
		normalizeMcpPreRegisteredOAuthClientInput({
			clientId: 'has space',
			clientSecret: 'x',
		}).ok,
	).toBe(false)

	expect(
		parseSealedMcpPreRegisteredOAuthClient({
			clientId,
			sealedClientSecret: 'v2.iv.ct',
		}),
	).toEqual({ clientId, sealedClientSecret: 'v2.iv.ct' })
	expect(parseSealedMcpPreRegisteredOAuthClient({ clientId })).toBeNull()
	expect(parseSealedMcpPreRegisteredOAuthClient(null)).toBeNull()
})
