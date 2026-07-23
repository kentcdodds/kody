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
		async exchangeToken() {
			throw new Error('Not implemented')
		},
		purgeExpiredData: async () => ({
			grantsChecked: 0,
			grantsPurged: 0,
			tokensChecked: 0,
			tokensPurged: 0,
			done: true,
		}),
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

type VerificationLookupKind =
	| 'email_and_stable_user_id'
	| 'stable_user_id_only'
	| 'email_only'

type MockDbOptions = {
	// Row returned for the `email_verified_at` lookup keyed by account email.
	emailVerifiedAt?: string | null
	// Row returned for the indexed `stable_user_id` verification lookup.
	stableUserVerifiedAt?: string | null
	// Expected bind values for the default verified fixture identity.
	expectedEmail?: string
	expectedStableUserId?: string
	// Optional authoritative users row for stable-id profile/RBAC resolution.
	accountByStableId?: MockAccountRow | null
	// Rows returned for remote connector settings queries.
	connectorRows?: Array<Record<string, unknown>>
	// Optional sink for which verification SQL shapes were exercised.
	verificationLookups?: Array<VerificationLookupKind>
}

function createMockDb(options: MockDbOptions = {}) {
	const defaultEmail = options.expectedEmail ?? 'user@example.com'
	const defaultStableUserId = options.expectedStableUserId ?? 'user'
	const expectedLeaseUserId =
		options.accountByStableId?.stable_user_id ?? defaultStableUserId
	const recordVerificationLookup = (kind: VerificationLookupKind) => {
		options.verificationLookups?.push(kind)
	}
	const statementFor = (query: string) => {
		const normalized = query.replace(/\s+/g, ' ').toLowerCase()
		let boundParams: Array<unknown> = []
		const statement = {
			bind(...params: Array<unknown>) {
				boundParams = params
				return statement
			},
			async all() {
				if (normalized.includes('from user_roles')) {
					return { results: [], meta: { changes: 0 } }
				}
				return {
					results: options.connectorRows ?? [],
					meta: { changes: 0 },
				}
			},
			async run() {
				if (normalized.startsWith('update users')) {
					if (
						!normalized.includes('where stable_user_id = ?') ||
						!boundParams.includes(expectedLeaseUserId)
					) {
						throw new Error('Unscoped account write lease update.')
					}
					return { meta: { changes: 1 } }
				}
				throw new Error(`Unsupported run query: ${query}`)
			},
			async first() {
				const boundStableUserId =
					typeof boundParams[0] === 'string' ? boundParams[0] : null
				const isProfileLookup =
					normalized.includes('from users') &&
					normalized.includes('where stable_user_id') &&
					normalized.includes('select id')
				if (isProfileLookup) {
					if (!boundStableUserId) return null
					if (options.accountByStableId !== undefined) {
						if (
							options.accountByStableId === null ||
							options.accountByStableId.stable_user_id !== boundStableUserId
						) {
							return null
						}
						return options.accountByStableId
					}
					if (boundStableUserId !== defaultStableUserId) return null
					const verifiedAt =
						options.stableUserVerifiedAt ?? options.emailVerifiedAt
					if (verifiedAt === undefined) return null
					return {
						id: 1,
						email: defaultEmail,
						username: 'user',
						display_name: null,
						stable_user_id: defaultStableUserId,
						email_verified_at: verifiedAt,
					} satisfies MockAccountRow
				}
				if (normalized.includes('email = ? and stable_user_id')) {
					recordVerificationLookup('email_and_stable_user_id')
					const email =
						typeof boundParams[0] === 'string' ? boundParams[0] : null
					const stableUserId =
						typeof boundParams[1] === 'string' ? boundParams[1] : null
					if (!email || !stableUserId) return null
					if (options.accountByStableId) {
						if (
							email !== options.accountByStableId.email ||
							stableUserId !== options.accountByStableId.stable_user_id
						) {
							return null
						}
						return {
							email_verified_at: options.accountByStableId.email_verified_at,
						}
					}
					if (email !== defaultEmail || stableUserId !== defaultStableUserId) {
						return null
					}
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
					recordVerificationLookup('stable_user_id_only')
					if (!boundStableUserId) return null
					if (options.accountByStableId) {
						if (
							options.accountByStableId.stable_user_id !== boundStableUserId
						) {
							return null
						}
						return {
							email_verified_at: options.accountByStableId.email_verified_at,
						}
					}
					if (boundStableUserId !== defaultStableUserId) return null
					return options.stableUserVerifiedAt === undefined
						? null
						: { email_verified_at: options.stableUserVerifiedAt }
				}
				if (
					normalized.includes('email_verified_at') &&
					normalized.includes('where email = ?') &&
					!normalized.includes('stable_user_id')
				) {
					// Mirrors production `isAccountEmailVerified` email-only path used by
					// browser sessions (oauth-handlers consent/approve with session email
					// only). MCP auth always supplies stable userId and must not rely on
					// this branch; see verificationLookups assertions below.
					recordVerificationLookup('email_only')
					const email =
						typeof boundParams[0] === 'string' ? boundParams[0] : null
					if (!email || email !== defaultEmail) return null
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
	const verificationLookups: Array<VerificationLookupKind> = []
	const verifiedDb: MockDbOptions = {
		emailVerifiedAt: new Date(0).toISOString(),
		verificationLookups,
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
	// MCP grant props carry email + stable userId, so verification must use the
	// paired lookup — never the browser-session email-only SQL shape.
	expect(verificationLookups).toContain('email_and_stable_user_id')
	expect(verificationLookups).not.toContain('email_only')

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
	const fallbackVerificationLookups: Array<VerificationLookupKind> = []
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
				verificationLookups: fallbackVerificationLookups,
			},
		),
		ctx: createContext(),
		fetchMcp,
	})
	expect(fallbackResponse.status).toBe(200)
	expect(fetchMcpCalled).toBe(true)
	expect(fallbackVerificationLookups).toContain('email_and_stable_user_id')
	expect(fallbackVerificationLookups).not.toContain('email_only')
})
