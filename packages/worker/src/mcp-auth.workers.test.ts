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
import { createStableUserIdFromEmail } from './user-id.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'

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

type MockAccountRow = {
	id: number
	email: string
	username: string | null
	display_name: string | null
	stable_user_id: string
	email_verified_at: string | null
}

type MockDbOptions = {
	// Row returned for the `email_verified_at` lookup keyed by account email.
	emailVerifiedAt?: string | null
	// Row returned for the indexed `stable_user_id` verification lookup.
	stableUserVerifiedAt?: string | null
	// Optional authoritative users row for stable-id profile/RBAC resolution.
	accountByStableId?: MockAccountRow | null
	// Rows returned for remote connector settings queries.
	connectorRows?: Array<Record<string, unknown>>
}

function createMockDb(options: MockDbOptions = {}) {
	const statementFor = (query: string) => {
		const normalized = query.replace(/\s+/g, ' ').toLowerCase()
		const statement = {
			bind: () => statement,
			async all() {
				if (normalized.includes('from user_roles')) {
					return { results: [], meta: { changes: 0 } }
				}
				return {
					results: options.connectorRows ?? [],
					meta: { changes: 0 },
				}
			},
			async first() {
				const isProfileLookup =
					normalized.includes('from users') &&
					normalized.includes('where stable_user_id') &&
					normalized.includes('select id')
				if (isProfileLookup) {
					if (options.accountByStableId !== undefined) {
						return options.accountByStableId
					}
					const verifiedAt =
						options.stableUserVerifiedAt ?? options.emailVerifiedAt
					if (verifiedAt === undefined) return null
					return {
						id: 1,
						email: 'user@example.com',
						username: 'user',
						display_name: null,
						stable_user_id: 'user',
						email_verified_at: verifiedAt,
					} satisfies MockAccountRow
				}
				if (normalized.includes('email = ? and stable_user_id')) {
					if (options.emailVerifiedAt !== undefined) {
						return { email_verified_at: options.emailVerifiedAt }
					}
					if (options.stableUserVerifiedAt !== undefined) {
						return { email_verified_at: options.stableUserVerifiedAt }
					}
					return null
				}
				if (
					normalized.includes('where stable_user_id') &&
					normalized.includes('email_verified_at')
				) {
					return options.stableUserVerifiedAt === undefined
						? null
						: { email_verified_at: options.stableUserVerifiedAt }
				}
				if (normalized.includes('email_verified_at')) {
					return options.emailVerifiedAt === undefined
						? null
						: { email_verified_at: options.emailVerifiedAt }
				}
				const result = await statement.all()
				return result.results[0] ?? null
			},
		}
		return statement
	}
	return {
		prepare: (query: string) => statementFor(query),
	} as unknown as D1Database
}

function createEnv(
	helpers: OAuthHelpers,
	overrides: Partial<Env> = {},
	dbOptions: MockDbOptions = {},
) {
	return {
		APP_DB: createMockDb(dbOptions),
		OAUTH_PROVIDER: helpers,
		...overrides,
	} as unknown as Env
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
	const workersDevOrigin = 'https://kody-production.kentcdodds.workers.dev'
	const appBaseUrl = 'https://heykody.dev'

	const requestOriginMetadataResponse = handleProtectedResourceMetadata(
		new Request(`${requestOrigin}${protectedResourceMetadataPath}`),
	)
	expect(requestOriginMetadataResponse.status).toBe(200)
	expect(await requestOriginMetadataResponse.json()).toEqual(
		buildProtectedResourceMetadata(requestOrigin),
	)

	// Request origin wins even when APP_BASE_URL is configured differently —
	// MCP clients require resource metadata to match the URL they connected to.
	const appBaseUrlMetadataResponse = handleProtectedResourceMetadata(
		new Request(`${workersDevOrigin}${protectedResourceMetadataPath}`),
		{
			APP_BASE_URL: appBaseUrl,
		} as Env,
	)
	expect(appBaseUrlMetadataResponse.status).toBe(200)
	expect(await appBaseUrlMetadataResponse.json()).toEqual(
		buildProtectedResourceMetadata(workersDevOrigin),
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
		request: new Request(`${workersDevOrigin}${mcpResourcePath}`),
		env: createEnv(createHelpers(), {
			APP_BASE_URL: appBaseUrl,
		}),
		ctx: createContext(),
		fetchMcp: () => new Response('ok'),
	})
	expect(appBaseUrlUnauthorizedResponse.status).toBe(401)
	expectAuthenticateHeader(
		appBaseUrlUnauthorizedResponse.headers.get('WWW-Authenticate') ?? '',
		workersDevOrigin,
	)
})

test('mcp request enforces token audience and forwards caller props', async () => {
	const request = new Request(`https://example.com${mcpResourcePath}`, {
		headers: { Authorization: 'Bearer token' },
	})
	const tokenWithoutAudience: TokenSummary = {
		id: 'token',
		grantId: 'grant',
		userId: 'user',
		createdAt: 0,
		expiresAt: 999999,
		grant: {
			clientId: 'client',
			scope: oauthScopes,
			props: { userId: 'user', email: 'user@example.com' },
		},
	}
	const validToken: TokenSummary = {
		...tokenWithoutAudience,
		audience: `https://example.com${mcpResourcePath}`,
	}
	const verifiedDb: MockDbOptions = {
		emailVerifiedAt: new Date(0).toISOString(),
	}

	const invalidResponse = await handleMcpRequest({
		request,
		env: createEnv(
			createHelpers({
				unwrapToken: async () => null,
			}),
		),
		ctx: createContext(),
		fetchMcp: () => new Response('ok'),
	})
	expect(invalidResponse.status).toBe(401)

	const missingAudienceResponse = await handleMcpRequest({
		request,
		env: createEnv(
			createHelpers({
				unwrapToken: async () => tokenWithoutAudience,
			}),
		),
		ctx: createContext(),
		fetchMcp: () => new Response('ok'),
	})
	expect(missingAudienceResponse.status).toBe(401)

	let receivedProps: unknown = null
	const validResponse = await handleMcpRequest({
		request,
		env: createEnv(
			createHelpers({
				unwrapToken: async () => validToken,
			}),
			{},
			verifiedDb,
		),
		ctx: createContext(),
		fetchMcp: (_request, _env, ctx) => {
			receivedProps = ctx.props
			return new Response('ok')
		},
	})
	expect(validResponse.status).toBe(200)
	expect(receivedProps).toMatchObject({
		baseUrl: 'https://example.com',
		executionOrigin: 'interactive',
		remoteConnectors: [],
		storageContext: null,
		user: { userId: 'user' },
	})

	const withConnectorResponse = await handleMcpRequest({
		request,
		env: createEnv(
			createHelpers({
				unwrapToken: async () => validToken,
			}),
			{},
			{
				...verifiedDb,
				connectorRows: [
					{
						id: 'connector-1',
						user_id: 'user',
						instance_id: 'home',
						enabled: 1,
						attached: 1,
						encrypted_shared_secret: 'encrypted',
						created_at: new Date(0).toISOString(),
						updated_at: new Date(0).toISOString(),
					},
				],
			},
		),
		ctx: createContext(),
		fetchMcp: (_request, _env, ctx) => {
			receivedProps = ctx.props
			return new Response('ok')
		},
	})
	expect(withConnectorResponse.status).toBe(200)
	expect(receivedProps).toMatchObject({
		remoteConnectors: [{ instanceId: 'home' }],
	})

	// The failing D1 lookup logs the roles-load failure before the request
	// rethrows the underlying error.
	consoleError.mockImplementation(() => {})
	const appDbUnavailable = {
		prepare: () => {
			throw new Error('D1 unavailable')
		},
	} as unknown as D1Database
	await expect(
		handleMcpRequest({
			request,
			env: createEnv(
				createHelpers({
					unwrapToken: async () => validToken,
				}),
				{ APP_DB: appDbUnavailable },
			),
			ctx: createContext(),
			fetchMcp: (_request, _env, ctx) => {
				receivedProps = ctx.props
				return new Response('ok')
			},
		}),
	).rejects.toThrow('D1 unavailable')
	expect(consoleError).toHaveBeenCalledWith(
		'Failed to load roles for MCP user context:',
		expect.any(Error),
	)
})

test('mcp request rejects unverified and unidentifiable accounts fail-closed', async () => {
	const request = new Request(`https://example.com${mcpResourcePath}`, {
		headers: { Authorization: 'Bearer token' },
	})
	function createToken(props: Record<string, unknown>): TokenSummary {
		return {
			id: 'token',
			grantId: 'grant',
			userId: 'user',
			createdAt: 0,
			expiresAt: 999999,
			audience: `https://example.com${mcpResourcePath}`,
			grant: {
				clientId: 'client',
				scope: oauthScopes,
				props,
			},
		}
	}

	let fetchMcpCalled = false
	const fetchMcp = () => {
		fetchMcpCalled = true
		return new Response('ok')
	}

	// Account exists but email_verified_at is null.
	const unverifiedResponse = await handleMcpRequest({
		request,
		env: createEnv(
			createHelpers({
				unwrapToken: async () =>
					createToken({ userId: 'user', email: 'user@example.com' }),
			}),
			{},
			{ emailVerifiedAt: null },
		),
		ctx: createContext(),
		fetchMcp,
	})
	expect(unverifiedResponse.status).toBe(403)
	expect(await unverifiedResponse.json()).toMatchObject({
		error: 'email_verification_required',
		error_description: expect.stringContaining('/account'),
	})

	// No matching account row at all.
	const unknownAccountResponse = await handleMcpRequest({
		request,
		env: createEnv(
			createHelpers({
				unwrapToken: async () =>
					createToken({ userId: 'user', email: 'user@example.com' }),
			}),
		),
		ctx: createContext(),
		fetchMcp,
	})
	expect(unknownAccountResponse.status).toBe(403)

	// Grant props without an identifiable user.
	const noUserResponse = await handleMcpRequest({
		request,
		env: createEnv(
			createHelpers({
				unwrapToken: async () => createToken({}),
			}),
		),
		ctx: createContext(),
		fetchMcp,
	})
	expect(noUserResponse.status).toBe(403)
	expect(fetchMcpCalled).toBe(false)

	// Indexed stable-user-id lookup verifies accounts when grant props lack email.
	const fallbackEmail = 'fallback@example.com'
	const stableUserId = await createStableUserIdFromEmail(fallbackEmail)
	const verifiedAt = new Date(0).toISOString()
	const fallbackResponse = await handleMcpRequest({
		request,
		env: createEnv(
			createHelpers({
				unwrapToken: async () => createToken({ userId: stableUserId }),
			}),
			{},
			{
				stableUserVerifiedAt: verifiedAt,
				accountByStableId: {
					id: 11,
					email: fallbackEmail,
					username: 'fallback',
					display_name: null,
					stable_user_id: stableUserId,
					email_verified_at: verifiedAt,
				},
			},
		),
		ctx: createContext(),
		fetchMcp,
	})
	expect(fallbackResponse.status).toBe(200)
	expect(fetchMcpCalled).toBe(true)
})
