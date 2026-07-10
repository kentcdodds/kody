import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { integrationSaveCapability } from './integration-save.ts'
import {
	buildIntegrationValueName,
	integrationConfigSchema,
	mergeIntegrationConfig,
	parseIntegrationConfig,
	parseIntegrationValueName,
} from './integration-shared.ts'

function createValueTestDb() {
	const entries = new Map<string, string>()

	const db = {
		prepare(query: string) {
			const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(...params: Array<unknown>) {
					return {
						async first<T>() {
							if (
								normalizedQuery.startsWith('select') &&
								normalizedQuery.includes('from value_buckets')
							) {
								return {
									id: 'bucket-1',
									user_id: String(params[0]),
									scope: String(params[1]),
									binding_key: '',
									expires_at: null,
									created_at: '2026-03-29T00:00:00.000Z',
									updated_at: '2026-03-29T00:00:00.000Z',
								} as T
							}
							if (
								normalizedQuery.startsWith('select') &&
								normalizedQuery.includes('from value_entries') &&
								normalizedQuery.includes('where bucket_id = ? and name = ?')
							) {
								const name = String(params[1])
								const value = entries.get(name)
								return value == null
									? null
									: ({
											bucket_id: 'bucket-1',
											name,
											description: `OAuth integration config for ${name}`,
											value,
											created_at: '2026-03-29T00:00:00.000Z',
											updated_at: '2026-03-29T00:00:00.000Z',
										} as T)
							}
							return null
						},
						async run() {
							if (normalizedQuery.startsWith('insert into value_entries')) {
								const name = String(params[1])
								const value = String(params[3])
								entries.set(name, value)
								return { meta: { changes: 1 } }
							}
							return { meta: { changes: 1 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database

	return { db, entries }
}

test('integration config helpers and integration_save persist validated integration records', async () => {
	const current = integrationConfigSchema.parse({
		name: 'spotify',
		tokenUrl: 'https://accounts.spotify.com/api/token',
		apiBaseUrl: 'https://api.spotify.com/v1',
		flow: 'pkce',
		clientIdValueName: 'spotify-client-id',
		clientSecretSecretName: null,
		accessTokenSecretName: 'spotifyAccessToken',
		refreshTokenSecretName: 'spotifyRefreshToken',
		requiredHosts: ['accounts.spotify.com', 'api.spotify.com'],
		authorization: {
			authorizeUrl: 'https://accounts.spotify.com/authorize',
			scopes: ['user-read-email'],
			scopeSeparator: ' ',
			extraAuthorizeParams: {},
		},
	})

	expect(
		mergeIntegrationConfig(current, {
			name: 'spotify',
			apiBaseUrl: 'https://api.spotify.com/v2/',
			authorization: {
				authorizeUrl: 'https://accounts.spotify.com/oauth2/authorize',
				scopes: ['user-read-email', 'playlist-read-private'],
				scopeSeparator: ' ',
				extraAuthorizeParams: { prompt: 'consent' },
			},
			requiredHosts: ['api.spotify.com'],
		}),
	).toEqual({
		...current,
		apiBaseUrl: 'https://api.spotify.com/v2/',
		authorization: {
			authorizeUrl: 'https://accounts.spotify.com/oauth2/authorize',
			scopes: ['user-read-email', 'playlist-read-private'],
			scopeSeparator: null,
			extraAuthorizeParams: { prompt: 'consent' },
		},
		requiredHosts: ['api.spotify.com'],
	})

	expect(
		parseIntegrationConfig(
			{
				name: 'spotify',
				tokenUrl: 'https://accounts.spotify.com/api/token',
				flow: 'pkce',
				clientIdValueName: 'spotify-client-id',
				clientSecretSecretName: null,
				accessTokenSecretName: 'spotifyAccessToken',
				refreshTokenSecretName: 'spotifyRefreshToken',
				requiredHosts: ['api.spotify.com'],
			},
			null,
		),
	).toMatchObject({
		name: 'spotify',
		apiBaseUrl: null,
	})

	expect(
		parseIntegrationConfig(
			{
				name: 'spotify',
				tokenUrl: 'https://accounts.spotify.com/api/token',
				flow: 'pkce',
				clientIdValueName: 'spotify-client-id',
				clientSecretSecretName: null,
				accessTokenSecretName: 'spotifyAccessToken',
				refreshTokenSecretName: 'spotifyRefreshToken',
				requiredHosts: ['api.spotify.com'],
				authorization: {
					authorizeUrl: 'ftp://accounts.spotify.com/authorize',
					scopes: ['user-read-email'],
				},
			},
			null,
		),
	).toBeNull()

	const testDb = createValueTestDb()

	const result = await integrationSaveCapability.handler(
		{
			name: 'spotify',
			tokenUrl: 'https://accounts.spotify.com/api/token',
			apiBaseUrl: 'https://api.spotify.com/v1',
			flow: 'pkce',
			clientIdValueName: 'spotify-client-id',
			clientSecretSecretName: null,
			accessTokenSecretName: 'spotifyAccessToken',
			refreshTokenSecretName: 'spotifyRefreshToken',
			requiredHosts: ['api.spotify.com'],
			authorization: {
				authorizeUrl: 'https://accounts.spotify.com/authorize',
				scopes: ['user-read-email', 'playlist-read-private'],
				scopeSeparator: ' ',
				extraAuthorizeParams: { show_dialog: 'true' },
			},
		},
		{
			env: { APP_DB: testDb.db } as unknown as Env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
				user: { userId: 'user-123' },
			}),
		},
	)

	expect(result.integration).toMatchObject({
		name: 'spotify',
		tokenUrl: 'https://accounts.spotify.com/api/token',
		apiBaseUrl: 'https://api.spotify.com/v1',
		flow: 'pkce',
		clientIdValueName: 'spotify-client-id',
		accessTokenSecretName: 'spotifyAccessToken',
		refreshTokenSecretName: 'spotifyRefreshToken',
		requiredHosts: ['api.spotify.com'],
		authorization: {
			authorizeUrl: 'https://accounts.spotify.com/authorize',
			scopes: ['user-read-email', 'playlist-read-private'],
			scopeSeparator: null,
			extraAuthorizeParams: { show_dialog: 'true' },
		},
	})
	expect(
		JSON.parse(testDb.entries.get('_integration:spotify') ?? '{}'),
	).toMatchObject({
		name: 'spotify',
		tokenUrl: 'https://accounts.spotify.com/api/token',
		apiBaseUrl: 'https://api.spotify.com/v1',
		flow: 'pkce',
		clientIdValueName: 'spotify-client-id',
		accessTokenSecretName: 'spotifyAccessToken',
		refreshTokenSecretName: 'spotifyRefreshToken',
		requiredHosts: ['api.spotify.com'],
		authorization: {
			authorizeUrl: 'https://accounts.spotify.com/authorize',
			scopes: ['user-read-email', 'playlist-read-private'],
			scopeSeparator: null,
			extraAuthorizeParams: { show_dialog: 'true' },
		},
	})

	const invalidDb = createValueTestDb()
	await expect(
		integrationSaveCapability.handler(
			{
				name: 'spotify',
				flow: 'pkce',
				clientIdValueName: 'spotify-client-id',
			},
			{
				env: { APP_DB: invalidDb.db } as unknown as Env,
				callerContext: createMcpCallerContext({
					baseUrl: 'https://heykody.dev',
					user: { userId: 'user-123' },
				}),
			},
		),
	).rejects.toThrow(/missing or invalid required fields/i)
	expect(invalidDb.entries.has('_integration:spotify')).toBe(false)

	const upsertDb = createValueTestDb()
	upsertDb.entries.set(
		'_integration:spotify',
		JSON.stringify({
			name: 'spotify',
			tokenUrl: 'https://accounts.spotify.com/api/token',
			apiBaseUrl: null,
			flow: 'pkce',
			clientIdValueName: 'spotify-client-id',
			clientSecretSecretName: null,
			accessTokenSecretName: 'spotifyAccessToken',
			refreshTokenSecretName: 'spotifyRefreshToken',
			requiredHosts: ['accounts.spotify.com', 'api.spotify.com'],
		}),
	)

	const upserted = await integrationSaveCapability.handler(
		{
			name: 'spotify',
			tokenUrl: 'https://accounts.spotify.com/api/token',
			apiBaseUrl: 'https://api.spotify.com/v1',
			flow: 'pkce',
			clientIdValueName: 'spotify-client-id',
			clientSecretSecretName: null,
			accessTokenSecretName: 'spotifyAccessToken',
			refreshTokenSecretName: 'spotifyRefreshToken',
			requiredHosts: ['api.spotify.com'],
		},
		{
			env: { APP_DB: upsertDb.db } as unknown as Env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
				user: { userId: 'user-123' },
			}),
		},
	)

	expect(upserted.integration).toMatchObject({
		name: 'spotify',
		apiBaseUrl: 'https://api.spotify.com/v1',
		requiredHosts: ['api.spotify.com'],
	})
	expect(
		JSON.parse(upsertDb.entries.get('_integration:spotify') ?? '{}'),
	).toMatchObject({
		apiBaseUrl: 'https://api.spotify.com/v1',
		requiredHosts: ['api.spotify.com'],
	})
})

test('integration_save persists usePkce only when it differs from the flow default', async () => {
	// Canva-style: confidential flow with PKCE enabled must round-trip.
	const canvaDb = createValueTestDb()
	const canvaResult = await integrationSaveCapability.handler(
		{
			name: 'canva',
			tokenUrl: 'https://api.canva.com/rest/v1/oauth/token',
			apiBaseUrl: 'https://api.canva.com/rest/v1',
			flow: 'confidential',
			usePkce: true,
			clientIdValueName: 'canva-client-id',
			clientSecretSecretName: 'canvaClientSecret',
			accessTokenSecretName: 'canvaAccessToken',
			refreshTokenSecretName: 'canvaRefreshToken',
			requiredHosts: ['api.canva.com'],
			tokenExchangeStyle: 'basic-form',
		},
		{
			env: { APP_DB: canvaDb.db } as unknown as Env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
				user: { userId: 'user-123' },
			}),
		},
	)
	expect(canvaResult.integration).toMatchObject({
		name: 'canva',
		flow: 'confidential',
		usePkce: true,
		tokenExchangeStyle: 'basic-form',
	})
	expect(
		JSON.parse(canvaDb.entries.get('_integration:canva') ?? '{}'),
	).toMatchObject({
		flow: 'confidential',
		usePkce: true,
		tokenExchangeStyle: 'basic-form',
	})

	// Flow-default PKCE choices normalize away instead of being stored.
	const defaultDb = createValueTestDb()
	const defaultResult = await integrationSaveCapability.handler(
		{
			name: 'spotify',
			tokenUrl: 'https://accounts.spotify.com/api/token',
			flow: 'pkce',
			usePkce: true,
			clientIdValueName: 'spotify-client-id',
			accessTokenSecretName: 'spotifyAccessToken',
			requiredHosts: ['api.spotify.com'],
		},
		{
			env: { APP_DB: defaultDb.db } as unknown as Env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
				user: { userId: 'user-123' },
			}),
		},
	)
	expect(defaultResult.integration).not.toHaveProperty('usePkce')
	expect(
		JSON.parse(defaultDb.entries.get('_integration:spotify') ?? '{}'),
	).not.toHaveProperty('usePkce')
})

test('integration identity is the canonical provider key across save, lookup, and value-name parsing', async () => {
	// Saving with display casing stores and returns the canonical name.
	const casedDb = createValueTestDb()
	const saved = await integrationSaveCapability.handler(
		{
			name: 'GitHub',
			tokenUrl: 'https://github.com/login/oauth/access_token',
			flow: 'confidential',
			clientIdValueName: 'github-client-id',
			clientSecretSecretName: 'githubClientSecret',
			accessTokenSecretName: 'githubAccessToken',
			requiredHosts: ['api.github.com'],
		},
		{
			env: { APP_DB: casedDb.db } as unknown as Env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
				user: { userId: 'user-123' },
			}),
		},
	)
	expect(saved.integration.name).toBe('github')
	expect(casedDb.entries.has('_integration:github')).toBe(true)
	expect(casedDb.entries.has('_integration:GitHub')).toBe(false)

	// Every value-key derivation goes through the same canonicalization.
	expect(buildIntegrationValueName('GitHub')).toBe('_integration:github')
	expect(buildIntegrationValueName('Spotify Family')).toBe(
		'_integration:spotify-family',
	)

	// Only canonical stored keys parse as integrations.
	expect(parseIntegrationValueName('_integration:github')).toBe('github')
	expect(parseIntegrationValueName('_integration:GitHub')).toBeNull()
	expect(parseIntegrationValueName('_integration:')).toBeNull()
	expect(parseIntegrationValueName('value:github')).toBeNull()

	// Names without any letters or numbers are rejected outright — including
	// ones made only of characters the canonical form preserves (. _ -).
	await expect(
		integrationSaveCapability.handler(
			{
				name: '._-',
				tokenUrl: 'https://example.com/token',
				flow: 'pkce',
				clientIdValueName: 'x-client-id',
				accessTokenSecretName: 'xAccessToken',
			},
			{
				env: { APP_DB: createValueTestDb().db } as unknown as Env,
				callerContext: createMcpCallerContext({
					baseUrl: 'https://heykody.dev',
					user: { userId: 'user-123' },
				}),
			},
		),
	).rejects.toThrow(/letters or numbers/i)
	await expect(
		integrationSaveCapability.handler(
			{
				name: '!!!',
				tokenUrl: 'https://example.com/token',
				flow: 'pkce',
				clientIdValueName: 'x-client-id',
				accessTokenSecretName: 'xAccessToken',
			},
			{
				env: { APP_DB: createValueTestDb().db } as unknown as Env,
				callerContext: createMcpCallerContext({
					baseUrl: 'https://heykody.dev',
					user: { userId: 'user-123' },
				}),
			},
		),
	).rejects.toThrow(/letters or numbers/i)
})
