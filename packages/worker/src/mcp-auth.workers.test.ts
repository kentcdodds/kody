import { expect, test } from 'vitest'
import {
	type OAuthHelpers,
	type TokenSummary,
} from '@cloudflare/workers-oauth-provider'
import {
	buildProtectedResourceMetadata,
	handleMcpRequest,
	handleProtectedResourceMetadata,
	mcpResourcePath,
	protectedResourceMetadataPath,
} from './mcp-auth.ts'
import { oauthScopes } from './oauth-handlers.ts'

function expectAuthenticateHeader(
	header: string,
	origin: string,
	options: {
		expectScope?: boolean
	} = {},
) {
	expect(header).toContain(
		`resource_metadata="${origin}${protectedResourceMetadataPath}"`,
	)

	if (options.expectScope ?? true) {
		if (oauthScopes.length > 0) {
			expect(header).toContain(`scope="${oauthScopes.join(' ')}"`)
		}
	}
}

function createHelpers(overrides: Partial<OAuthHelpers> = {}): OAuthHelpers {
	return {
		async parseAuthRequest() {
			throw new Error('Not implemented')
		},
		lookupClient: async () => null,
		completeAuthorization: async () => ({ redirectTo: 'https://example.com' }),
		async createClient() {
			throw new Error('Not implemented')
		},
		listClients: async () => ({ items: [] }),
		updateClient: async () => null,
		deleteClient: async () => undefined,
		listUserGrants: async () => ({ items: [] }),
		revokeGrant: async () => undefined,
		unwrapToken: async () => null,
		...overrides,
	}
}

function createEnv(helpers: OAuthHelpers, overrides: Partial<Env> = {}) {
	return { OAUTH_PROVIDER: helpers, ...overrides } as unknown as Env
}

function createContext() {
	return {
		props: {},
		waitUntil: () => undefined,
		passThroughOnException: () => undefined,
	} as unknown as ExecutionContext
}

test('protected resource metadata and auth challenge resolve origin consistently', async () => {
	const requestOrigin = 'https://example.com'
	const appBaseUrl = 'https://heykody.dev'

	const requestOriginMetadataResponse = handleProtectedResourceMetadata(
		new Request(`${requestOrigin}${protectedResourceMetadataPath}`),
	)
	expect(requestOriginMetadataResponse.status).toBe(200)
	expect(await requestOriginMetadataResponse.json()).toEqual(
		buildProtectedResourceMetadata(requestOrigin),
	)

	const appBaseUrlMetadataResponse = handleProtectedResourceMetadata(
		new Request(
			`https://kody-production.kentcdodds.workers.dev${protectedResourceMetadataPath}`,
		),
		{
			APP_BASE_URL: appBaseUrl,
		} as Env,
	)
	expect(appBaseUrlMetadataResponse.status).toBe(200)
	expect(await appBaseUrlMetadataResponse.json()).toEqual(
		buildProtectedResourceMetadata(appBaseUrl),
	)

	const requestOriginUnauthorizedResponse = await handleMcpRequest({
		request: new Request(`${requestOrigin}${mcpResourcePath}`),
		env: createEnv(createHelpers()),
		ctx: createContext(),
		fetchMcp: () => new Response('ok'),
	})
	expect(requestOriginUnauthorizedResponse.status).toBe(401)
	expectAuthenticateHeader(
		requestOriginUnauthorizedResponse.headers.get('WWW-Authenticate') ?? '',
		requestOrigin,
	)

	const appBaseUrlUnauthorizedResponse = await handleMcpRequest({
		request: new Request(
			`https://kody-production.kentcdodds.workers.dev${mcpResourcePath}`,
		),
		env: createEnv(createHelpers(), {
			APP_BASE_URL: appBaseUrl,
		}),
		ctx: createContext(),
		fetchMcp: () => new Response('ok'),
	})
	expect(appBaseUrlUnauthorizedResponse.status).toBe(401)
	expectAuthenticateHeader(
		appBaseUrlUnauthorizedResponse.headers.get('WWW-Authenticate') ?? '',
		appBaseUrl,
	)
})

test('mcp request rejects invalid tokens', async () => {
	const request = new Request(`https://example.com${mcpResourcePath}`, {
		headers: { Authorization: 'Bearer invalid' },
	})
	const response = await handleMcpRequest({
		request,
		env: createEnv(
			createHelpers({
				unwrapToken: async () => null,
			}),
		),
		ctx: createContext(),
		fetchMcp: () => new Response('ok'),
	})

	expect(response.status).toBe(401)
})

test('mcp request rejects tokens without resource audience', async () => {
	const tokenSummary: TokenSummary = {
		id: 'token',
		grantId: 'grant',
		userId: 'user',
		createdAt: 0,
		expiresAt: 999999,
		grant: {
			clientId: 'client',
			scope: oauthScopes,
			props: { userId: 'user' },
		},
	}
	const response = await handleMcpRequest({
		request: new Request(`https://example.com${mcpResourcePath}`, {
			headers: { Authorization: 'Bearer valid' },
		}),
		env: createEnv(
			createHelpers({
				unwrapToken: async () => tokenSummary,
			}),
		),
		ctx: createContext(),
		fetchMcp: () => new Response('ok'),
	})

	expect(response.status).toBe(401)
})

test('mcp request forwards when token is valid', async () => {
	const tokenSummary: TokenSummary = {
		id: 'token',
		grantId: 'grant',
		userId: 'user',
		createdAt: 0,
		expiresAt: 999999,
		audience: `https://example.com${mcpResourcePath}`,
		grant: {
			clientId: 'client',
			scope: oauthScopes,
			props: { userId: 'user' },
		},
	}
	let receivedProps: unknown = null
	const response = await handleMcpRequest({
		request: new Request(`https://example.com${mcpResourcePath}`, {
			headers: { Authorization: 'Bearer valid' },
		}),
		env: createEnv(
			createHelpers({
				unwrapToken: async () => tokenSummary,
			}),
		),
		ctx: createContext(),
		fetchMcp: (_request, _env, ctx) => {
			receivedProps = ctx.props
			return new Response('ok')
		},
	})

	expect(response.status).toBe(200)
	expect(receivedProps).toEqual({
		baseUrl: 'https://example.com',
		homeConnectorId: 'default',
		storageContext: null,
		user: { userId: 'user' },
	})
})
