import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { integrationSaveCapability } from './integration-save.ts'
import {
	integrationConfigSchema,
	mergeIntegrationConfig,
	parseIntegrationConfig,
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

test('mergeIntegrationConfig applies patch fields and preserves existing fields', () => {
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
	})

	const merged = mergeIntegrationConfig(current, {
		name: 'spotify',
		apiBaseUrl: 'https://api.spotify.com/v2/',
		requiredHosts: ['api.spotify.com'],
	})

	expect(merged).toEqual({
		...current,
		apiBaseUrl: 'https://api.spotify.com/v2/',
		requiredHosts: ['api.spotify.com'],
	})
})

test('parseIntegrationConfig keeps older rows readable when apiBaseUrl is missing', () => {
	const parsed = parseIntegrationConfig(
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
	)

	expect(parsed).toMatchObject({
		name: 'spotify',
		apiBaseUrl: null,
	})
})

test('integration_save creates a new integration record', async () => {
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
	})
})

test('integration_save reports missing fields for new integration records', async () => {
	const testDb = createValueTestDb()

	await expect(
		integrationSaveCapability.handler(
			{
				name: 'spotify',
				flow: 'pkce',
				clientIdValueName: 'spotify-client-id',
			},
			{
				env: { APP_DB: testDb.db } as unknown as Env,
				callerContext: createMcpCallerContext({
					baseUrl: 'https://heykody.dev',
					user: { userId: 'user-123' },
				}),
			},
		),
	).rejects.toThrow(
		'Cannot create integration "spotify": missing or invalid required fields',
	)
	expect(testDb.entries.has('_integration:spotify')).toBe(false)
})

test('integration_save upserts an existing integration record', async () => {
	const testDb = createValueTestDb()
	testDb.entries.set(
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
		apiBaseUrl: 'https://api.spotify.com/v1',
		requiredHosts: ['api.spotify.com'],
	})
	expect(
		JSON.parse(testDb.entries.get('_integration:spotify') ?? '{}'),
	).toMatchObject({
		apiBaseUrl: 'https://api.spotify.com/v1',
		requiredHosts: ['api.spotify.com'],
	})
})
