import { env } from 'cloudflare:workers'
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
import { createWaitUntilDrain } from '#worker/test-support/user-meter.ts'

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
	deleting_at?: string | null
	suspended_at?: string | null
}

type VerificationLookupKind =
	| 'email_and_stable_user_id'
	| 'stable_user_id_only'
	| 'email_only'

type MockDbOptions = {
	// Row returned for the `email_verified_at` lookup keyed by account email.
	emailVerifiedAt?: string | null
	// Row returned for the `suspended_at` lookup keyed by account identity.
	suspendedAt?: string | null
	// Row returned for the indexed `stable_user_id` verification lookup.
	stableUserVerifiedAt?: string | null
	// Expected bind values for the default verified fixture identity.
	expectedEmail?: string
	expectedStableUserId?: string
	// Optional authoritative users row for stable-id profile/RBAC resolution.
	accountByStableId?: MockAccountRow | null
	// Rows returned for remote connector settings queries.
	connectorRows?: Array<Record<string, unknown>>
	// Optional sink for audit rows written while rejecting a request.
	auditInserts?: Array<Array<unknown>>
	// Optional sink for which verification SQL shapes were exercised.
	verificationLookups?: Array<VerificationLookupKind>
	// Optional sink for consolidated users SELECTs.
	userSelects?: Array<string>
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
				// Denials that resolve to a principal are recorded in the audit
				// log on the way out.
				if (normalized.startsWith('insert into audit_events')) {
					options.auditInserts?.push(boundParams)
					return { meta: { changes: 1 } }
				}
				if (normalized.startsWith('delete from account_write_leases')) {
					if (!boundParams.includes(expectedLeaseUserId)) {
						throw new Error('Unscoped account write lease delete.')
					}
					return { meta: { changes: 1 } }
				}
				if (normalized.startsWith('insert into account_write_leases')) {
					if (!boundParams.includes(expectedLeaseUserId)) {
						throw new Error('Unscoped account write lease insert.')
					}
					return { meta: { changes: 1 } }
				}
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
					options.userSelects?.push(normalized)
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
						deleting_at: null,
						suspended_at: options.suspendedAt ?? null,
					} satisfies MockAccountRow
				}
				if (normalized.includes('select 1 as held from account_write_leases')) {
					return { held: 1 }
				}
				if (normalized.includes('select deleting_at from users')) {
					if (!boundStableUserId) return null
					if (options.accountByStableId !== undefined) {
						if (
							options.accountByStableId === null ||
							options.accountByStableId.stable_user_id !== boundStableUserId
						) {
							return null
						}
						return {
							deleting_at: options.accountByStableId.deleting_at ?? null,
						}
					}
					if (boundStableUserId !== defaultStableUserId) return null
					return { deleting_at: null }
				}
				if (normalized.includes('select suspended_at from users')) {
					// Validate the bound identity like the adjacent
					// verification branches so a widened isAccountSuspended
					// query scope fails this mock.
					const email =
						typeof boundParams[0] === 'string' ? boundParams[0] : null
					if (email !== defaultEmail) return null
					if (normalized.includes('stable_user_id')) {
						const stableUserId =
							typeof boundParams[1] === 'string' ? boundParams[1] : null
						if (stableUserId !== defaultStableUserId) return null
					}
					return { suspended_at: options.suspendedAt ?? null }
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
		async batch(statements: Array<{ run: () => Promise<unknown> }>) {
			const results = []
			for (const statement of statements) {
				results.push(await statement.run())
			}
			return results
		},
	} as unknown as D1Database
}

function createEnv(
	helpers: OAuthHelpers,
	overrides: Partial<Env> = {},
	dbOptions: MockDbOptions = {},
) {
	const db = createMockDb(dbOptions)
	return {
		APP_DB: db,
		AUDIT_DB: db,
		OAUTH_PROVIDER: helpers,
		USER_METER: env.USER_METER,
		...overrides,
	} as unknown as Env
}

function createContext() {
	const drain = createWaitUntilDrain()
	return {
		props: {},
		waitUntil: drain.waitUntil,
		passThroughOnException: () => undefined,
		drain: drain.drain,
	}
}

type TestContext = ReturnType<typeof createContext>

async function handleMcpRequestAndDrain(
	input: Omit<Parameters<typeof handleMcpRequest>[0], 'ctx'> & {
		ctx: TestContext
	},
) {
	const response = await handleMcpRequest({
		...input,
		ctx: input.ctx as unknown as ExecutionContext,
	})
	await input.ctx.drain()
	return response
}

test('mcp endpoint serves browser guidance without changing protocol auth challenges', async () => {
	const origin = 'https://example.com'
	const env = createEnv(createHelpers())
	const fetchMcp = () => {
		throw new Error(
			'Unauthenticated requests must not reach the MCP transport.',
		)
	}

	const browserResponse = await handleMcpRequestAndDrain({
		request: new Request(`${origin}${mcpResourcePath}`, {
			headers: {
				Accept:
					'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
			},
		}),
		env,
		ctx: createContext(),
		fetchMcp,
	})
	expect(browserResponse.status).toBe(200)
	expect(browserResponse.headers.get('Content-Type')).toBe(
		'text/html; charset=utf-8',
	)
	expect(await browserResponse.text()).toContain(
		'href="https://example.com/onboarding"',
	)
	expect(browserResponse.headers.get('WWW-Authenticate')).toBeNull()

	const protocolRequests = [
		new Request(`${origin}${mcpResourcePath}`, {
			headers: { Accept: 'text/event-stream' },
		}),
		new Request(`${origin}${mcpResourcePath}`, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
			}),
		}),
		new Request(`${origin}${mcpResourcePath}`, {
			headers: {
				Accept: 'text/html',
				Authorization: 'Bearer invalid-token',
			},
		}),
	]

	for (const request of protocolRequests) {
		const response = await handleMcpRequestAndDrain({
			request,
			env,
			ctx: createContext(),
			fetchMcp,
		})
		expect(response.status).toBe(401)
		expect(response.headers.get('Content-Type')).toMatch(/application\/json/)
		expect(await response.json()).toEqual({
			error: 'invalid_token',
			error_description:
				'Authentication required. Obtain an access token via OAuth and retry with Authorization: Bearer.',
		})
		expectAuthenticateHeader(
			response.headers.get('WWW-Authenticate') ?? '',
			origin,
		)
	}
})

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

	const requestOriginUnauthorizedResponse = await handleMcpRequestAndDrain({
		request: new Request(`${requestOrigin}${mcpResourcePath}`),
		env: createEnv(createHelpers()),
		ctx: createContext(),
		fetchMcp: () => new Response('ok'),
	})
	expect(requestOriginUnauthorizedResponse.status).toBe(401)
	expect(requestOriginUnauthorizedResponse.headers.get('Content-Type')).toMatch(
		/application\/json/,
	)
	expect(await requestOriginUnauthorizedResponse.json()).toEqual({
		error: 'invalid_token',
		error_description:
			'Authentication required. Obtain an access token via OAuth and retry with Authorization: Bearer.',
	})
	expectAuthenticateHeader(
		requestOriginUnauthorizedResponse.headers.get('WWW-Authenticate') ?? '',
		requestOrigin,
	)

	const appBaseUrlUnauthorizedResponse = await handleMcpRequestAndDrain({
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

test('protected resource metadata advertises header bearer methods', () => {
	const metadata = buildProtectedResourceMetadata('https://example.com')
	expect(metadata.bearer_methods_supported).toEqual(['header'])
	expect(metadata.resource).toBe('https://example.com/mcp')
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
	const userSelects: Array<string> = []
	const verifiedDb: MockDbOptions = {
		emailVerifiedAt: new Date(0).toISOString(),
		verificationLookups,
		userSelects,
	}

	const invalidResponse = await handleMcpRequestAndDrain({
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

	const missingAudienceResponse = await handleMcpRequestAndDrain({
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
	const validResponse = await handleMcpRequestAndDrain({
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
	expect(userSelects).toHaveLength(1)
	expect(userSelects[0]).toContain('email_verified_at')
	expect(userSelects[0]).toContain('suspended_at')
	expect(verificationLookups).toHaveLength(0)

	const withConnectorResponse = await handleMcpRequestAndDrain({
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
		handleMcpRequestAndDrain({
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
		'Failed to load MCP auth user context:',
		expect.any(Error),
	)
}, 15_000)

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
	const unverifiedResponse = await handleMcpRequestAndDrain({
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
	const unknownAccountResponse = await handleMcpRequestAndDrain({
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
	const noUserResponse = await handleMcpRequestAndDrain({
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

	// Verified but suspended accounts are rejected with a dedicated error, and
	// the rejection is recorded so a suspended principal that keeps calling
	// stays visible instead of failing silently.
	const auditInserts: Array<Array<unknown>> = []
	const suspendedResponse = await handleMcpRequestAndDrain({
		request,
		env: createEnv(
			createHelpers({
				unwrapToken: async () =>
					createToken({ userId: 'user', email: 'user@example.com' }),
			}),
			{},
			{
				auditInserts,
				emailVerifiedAt: new Date(0).toISOString(),
				suspendedAt: new Date(0).toISOString(),
			},
		),
		ctx: createContext(),
		fetchMcp,
	})
	expect(suspendedResponse.status).toBe(403)
	expect(await suspendedResponse.json()).toMatchObject({
		error: 'account_suspended',
	})
	expect(fetchMcpCalled).toBe(false)
	expect(auditInserts).toHaveLength(1)
	// category, action, result, then the hashed email — never the raw address.
	expect(auditInserts[0]?.slice(0, 3)).toEqual([
		'auth',
		'mcp_token_rejected',
		'failure',
	])
	expect(auditInserts[0]).not.toContain('user@example.com')

	// Indexed stable-user-id lookup verifies accounts when grant props lack email.
	const fallbackEmail = 'fallback@example.com'
	const stableUserId = await createStableUserIdFromEmail(fallbackEmail)
	const verifiedAt = new Date(0).toISOString()
	const fallbackUserSelects: Array<string> = []
	const fallbackResponse = await handleMcpRequestAndDrain({
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
				userSelects: fallbackUserSelects,
			},
		),
		ctx: createContext(),
		fetchMcp,
	})
	expect(fallbackResponse.status).toBe(200)
	expect(fetchMcpCalled).toBe(true)
	expect(fallbackUserSelects).toHaveLength(1)
	expect(fallbackUserSelects[0]).toContain('email_verified_at')
	expect(fallbackUserSelects[0]).toContain('suspended_at')
})
