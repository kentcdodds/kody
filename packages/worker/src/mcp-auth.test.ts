/// <reference types="bun" />
import { expect, test } from 'bun:test'
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

function createEnv(helpers: OAuthHelpers) {
	return { OAUTH_PROVIDER: helpers } as unknown as Env
}

function createContext() {
	return {
		props: {},
		waitUntil: () => undefined,
		passThroughOnException: () => undefined,
	} as unknown as ExecutionContext
}

test('protected resource metadata describes MCP server', async () => {
	const request = new Request(
		`https://example.com${protectedResourceMetadataPath}`,
	)
	const response = handleProtectedResourceMetadata(request)

	expect(response.status).toBe(200)
	const payload = await response.json()
	expect(payload).toEqual(buildProtectedResourceMetadata('https://example.com'))
})

test('mcp request without token returns 401 with resource metadata', async () => {
	const request = new Request(`https://example.com${mcpResourcePath}`)
	const response = await handleMcpRequest({
		request,
		env: createEnv(createHelpers()),
		ctx: createContext(),
		fetchMcp: () => new Response('ok'),
	})

	expect(response.status).toBe(401)
	const header = response.headers.get('WWW-Authenticate') ?? ''
	expect(header).toContain(
		`resource_metadata="https://example.com${protectedResourceMetadataPath}"`,
	)
	if (oauthScopes.length > 0) {
		expect(header).toContain(`scope="${oauthScopes.join(' ')}"`)
	}
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
		user: { userId: 'user' },
	})
})
