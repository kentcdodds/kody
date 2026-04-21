import { expect, test } from 'vitest'
import { buildCapabilityRegistry } from '#mcp/capabilities/build-capability-registry.ts'
import { buildConnectorValueName } from '#mcp/capabilities/values/connector-shared.ts'
import {
	loadDownHomeConnectorStatus,
	loadOptionalSearchRows,
	resolveSearchMemoryContext,
	searchPackages,
	searchUnified,
	type OptionalSearchRowsResult,
	type PackageSearchRow,
} from './search.ts'

test('searchUnified ranks mixed search rows through one shared pipeline', () => {
	const registry = buildCapabilityRegistry([
		{
			name: 'meta',
			description: 'Meta capabilities',
			capabilities: [
				{
					name: 'alpha beta',
					domain: 'meta',
					description: 'gamma helper',
					keywords: [],
					readOnly: true,
					idempotent: true,
					destructive: false,
					inputSchema: {
						type: 'object',
						properties: {},
					},
					handler: async () => null,
				},
			],
		},
	])
	const packageRows: Array<PackageSearchRow> = [
		{
			record: {
				id: 'pkg-1',
				userId: 'user-1',
				name: 'alpha',
				kodyId: 'beta',
				description: 'gamma',
				tags: ['delta'],
				searchText: 'epsilon',
				sourceId: 'source-1',
				hasApp: false,
				createdAt: '2026-04-20T00:00:00.000Z',
				updatedAt: '2026-04-20T00:00:00.000Z',
			},
			projection: {
				name: 'alpha',
				kodyId: 'beta',
				description: 'gamma',
				tags: ['delta'],
				searchText: 'epsilon',
				hasApp: false,
				exports: [],
				jobs: [],
			},
		},
	]
	const optionalRows = {
		packageRows,
		userSecretRows: [
			{
				name: 'alpha-secret',
				scope: 'user',
				description: 'beta gamma delta secret',
				appId: null,
				updatedAt: '2026-04-20T00:00:00.000Z',
			},
		],
		userValueRows: [
			{
				name: 'preferred-alpha',
				scope: 'user',
				value: 'beta',
				description: 'gamma delta',
				appId: null,
				createdAt: '2026-04-20T00:00:00.000Z',
				updatedAt: '2026-04-20T00:00:00.000Z',
				ttlMs: null,
			},
			{
				name: buildConnectorValueName('github'),
				scope: 'user',
				value: JSON.stringify({
					tokenUrl: 'https://delta.example/token',
					apiBaseUrl: 'https://epsilon.example/api',
					flow: 'confidential',
					clientIdValueName: 'github-client-id',
					clientSecretSecretName: 'github-client-secret',
					accessTokenSecretName: 'github-access-token',
					refreshTokenSecretName: 'github-refresh-token',
					requiredHosts: ['epsilon.example'],
				}),
				description: 'alpha beta gamma connector',
				appId: null,
				createdAt: '2026-04-20T00:00:00.000Z',
				updatedAt: '2026-04-20T00:00:00.000Z',
				ttlMs: null,
			},
		],
		warnings: [],
	} satisfies OptionalSearchRowsResult

	const result = searchUnified({
		env: {} as Env,
		query: 'alpha\nbeta\ngamma\ndelta\nepsilon',
		limit: 5,
		registry,
		optionalRows,
	})

	expect(result.offline).toBe(true)
	expect(result.matches).toHaveLength(5)
	expect(result.matches).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				type: 'capability',
				name: 'alpha beta',
			}),
			expect.objectContaining({
				type: 'package',
				packageId: 'pkg-1',
			}),
			expect.objectContaining({
				type: 'value',
				name: 'preferred-alpha',
			}),
			expect.objectContaining({
				type: 'connector',
				connectorName: 'github',
			}),
			expect.objectContaining({
				type: 'secret',
				name: 'alpha-secret',
			}),
		]),
	)
})

test('searchUnified prioritizes spotify package and connector for operational queries', () => {
	const registry = buildCapabilityRegistry([])
	const optionalRows = {
		packageRows: [
			{
				record: {
					id: 'pkg-spotify',
					userId: 'user-1',
					name: '@kody/spotify-controller',
					kodyId: 'spotify-controller',
					description: 'Control Spotify playback from saved workflows.',
					tags: ['spotify', 'audio'],
					searchText: 'spotify playback',
					sourceId: 'source-spotify',
					hasApp: false,
					createdAt: '2026-04-20T00:00:00.000Z',
					updatedAt: '2026-04-20T00:00:00.000Z',
				},
				projection: {
					name: '@kody/spotify-controller',
					kodyId: 'spotify-controller',
					description: 'Control Spotify playback from saved workflows.',
					tags: ['spotify', 'audio'],
					searchText: 'spotify playback',
					hasApp: false,
					exports: ['./playback'],
					jobs: [],
				},
			},
			{
				record: {
					id: 'pkg-generic-player',
					userId: 'user-1',
					name: '@kody/laptop-music-player',
					kodyId: 'laptop-music-player',
					description: 'Play music on your laptop with saved automations.',
					tags: ['music', 'laptop'],
					searchText: 'play music on laptop',
					sourceId: 'source-generic-player',
					hasApp: false,
					createdAt: '2026-04-20T00:00:00.000Z',
					updatedAt: '2026-04-20T00:00:00.000Z',
				},
				projection: {
					name: '@kody/laptop-music-player',
					kodyId: 'laptop-music-player',
					description: 'Play music on your laptop with saved automations.',
					tags: ['music', 'laptop'],
					searchText: 'play music on laptop',
					hasApp: false,
					exports: ['./start'],
					jobs: [],
				},
			},
		],
		userSecretRows: [],
		userValueRows: [
			{
				name: buildConnectorValueName('spotify'),
				scope: 'user',
				value: JSON.stringify({
					tokenUrl: 'https://accounts.spotify.com/api/token',
					apiBaseUrl: 'https://api.spotify.com/v1',
					flow: 'confidential',
					clientIdValueName: 'spotify-client-id',
					clientSecretSecretName: 'spotify-client-secret',
					accessTokenSecretName: 'spotify-access-token',
					refreshTokenSecretName: 'spotify-refresh-token',
					requiredHosts: ['api.spotify.com'],
				}),
				description: 'Spotify connector for playback control.',
				appId: null,
				createdAt: '2026-04-20T00:00:00.000Z',
				updatedAt: '2026-04-20T00:00:00.000Z',
				ttlMs: null,
			},
			{
				name: buildConnectorValueName('laptop-audio'),
				scope: 'user',
				value: JSON.stringify({
					tokenUrl: 'https://player.example/token',
					apiBaseUrl: 'https://player.example/api',
					flow: 'confidential',
					clientIdValueName: 'player-client-id',
					clientSecretSecretName: 'player-client-secret',
					accessTokenSecretName: 'player-access-token',
					refreshTokenSecretName: 'player-refresh-token',
					requiredHosts: ['player.example'],
				}),
				description: 'Play music on your laptop.',
				appId: null,
				createdAt: '2026-04-20T00:00:00.000Z',
				updatedAt: '2026-04-20T00:00:00.000Z',
				ttlMs: null,
			},
		],
		warnings: [],
	} satisfies OptionalSearchRowsResult

	const result = searchUnified({
		env: {} as Env,
		query: 'spotify play music on my laptop',
		limit: 4,
		registry,
		optionalRows,
	})

	expect(result.matches.slice(0, 2)).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				type: 'package',
				kodyId: 'spotify-controller',
			}),
			expect.objectContaining({
				type: 'connector',
				connectorName: 'spotify',
			}),
		]),
	)
})

test('searchPackages prefers the named integration over generic action matches', async () => {
	const rows: Array<PackageSearchRow> = [
		{
			record: {
				id: 'pkg-gmail',
				userId: 'user-1',
				name: '@kody/gmail-actions',
				kodyId: 'gmail-actions',
				description: 'Run Gmail actions from saved workflows.',
				tags: ['gmail', 'email'],
				searchText: 'gmail inbox actions',
				sourceId: 'source-gmail',
				hasApp: false,
				createdAt: '2026-04-20T00:00:00.000Z',
				updatedAt: '2026-04-20T00:00:00.000Z',
			},
			projection: {
				name: '@kody/gmail-actions',
				kodyId: 'gmail-actions',
				description: 'Run Gmail actions from saved workflows.',
				tags: ['gmail', 'email'],
				searchText: 'gmail inbox actions',
				hasApp: false,
				exports: ['./mail'],
				jobs: [],
			},
		},
		{
			record: {
				id: 'pkg-generic-email',
				userId: 'user-1',
				name: '@kody/laptop-email-sender',
				kodyId: 'laptop-email-sender',
				description: 'Send email from your laptop with saved workflows.',
				tags: ['email', 'laptop'],
				searchText: 'send email from laptop',
				sourceId: 'source-generic-email',
				hasApp: false,
				createdAt: '2026-04-20T00:00:00.000Z',
				updatedAt: '2026-04-20T00:00:00.000Z',
			},
			projection: {
				name: '@kody/laptop-email-sender',
				kodyId: 'laptop-email-sender',
				description: 'Send email from your laptop with saved workflows.',
				tags: ['email', 'laptop'],
				searchText: 'send email from laptop',
				hasApp: false,
				exports: ['./send'],
				jobs: [],
			},
		},
	]

	const result = await searchPackages({
		env: {} as Env,
		baseUrl: 'https://example.com',
		query: 'gmail send email from my laptop',
		limit: 2,
		rows,
	})

	expect(result.offline).toBe(true)
	expect(result.matches[0]).toMatchObject({
		type: 'package',
		kodyId: 'gmail-actions',
	})
})

test('search memory context falls back to the query when omitted', () => {
	expect(
		resolveSearchMemoryContext({
			query: 'saved interactive dashboard app',
		}),
	).toEqual({
		query: 'saved interactive dashboard app',
	})
})

test('search memory context preserves explicit caller context', () => {
	expect(
		resolveSearchMemoryContext({
			query: 'saved interactive dashboard app',
			memoryContext: {
				task: 'Find dashboard app',
				query: 'saved dashboard app',
				entities: ['dashboard'],
			},
		}),
	).toEqual({
		task: 'Find dashboard app',
		query: 'saved dashboard app',
		entities: ['dashboard'],
	})
})

test('search memory context does not synthesize a fallback for blank queries', () => {
	expect(
		resolveSearchMemoryContext({
			query: '   ',
		}),
	).toBeUndefined()
})

test('optional search rows fall back when saved packages lookup fails', async () => {
	const result = await loadOptionalSearchRows({
		userId: 'user-123',
		loadPackages: async () => {
			throw new Error('D1 packages unavailable')
		},
		loadUserSecrets: async () => [],
		loadUserValues: async () => [],
	})

	expect(result.packageRows).toEqual([])
	expect(result.userSecretRows).toEqual([])
	expect(result.userValueRows).toEqual([])
	expect(result.warnings).toEqual([
		'Saved packages are temporarily unavailable: D1 packages unavailable',
	])
})

test('optional search rows include saved packages when lookup succeeds', async () => {
	const result = await loadOptionalSearchRows({
		userId: 'user-123',
		loadPackages: async () => [
			{
				record: {
					id: 'package-123',
					userId: 'user-123',
					name: '@kody/roku-remote',
					kodyId: 'roku-remote',
					description: 'Saved package for the Roku remote',
					tags: ['roku'],
					searchText: null,
					sourceId: 'source-package-123',
					hasApp: true,
					createdAt: '2026-03-24T00:00:00.000Z',
					updatedAt: '2026-03-24T00:00:00.000Z',
				},
				projection: {
					name: '@kody/roku-remote',
					kodyId: 'roku-remote',
					description: 'Saved package for the Roku remote',
					tags: ['roku'],
					searchText: null,
					hasApp: true,
					exports: ['.'],
					jobs: [],
				},
			},
		],
		loadUserSecrets: async () => [],
		loadUserValues: async () => [],
	})

	expect(result.packageRows).toHaveLength(1)
	expect(result.userSecretRows).toEqual([])
	expect(result.userValueRows).toEqual([])
	expect(result.warnings).toEqual([])
})

test('optional search rows fall back when persisted values lookup fails', async () => {
	const result = await loadOptionalSearchRows({
		userId: 'user-123',
		loadPackages: async () => [],
		loadUserSecrets: async () => [],
		loadUserValues: async () => {
			throw new Error('D1 values unavailable')
		},
	})

	expect(result.packageRows).toEqual([])
	expect(result.userSecretRows).toEqual([])
	expect(result.userValueRows).toEqual([])
	expect(result.warnings).toEqual([
		'Persisted values are temporarily unavailable: D1 values unavailable',
	])
})

test('optional search rows skip D1 access without a user', async () => {
	const result = await loadOptionalSearchRows({
		userId: null,
		loadPackages: async () => {
			throw new Error('should not run')
		},
		loadUserSecrets: async () => [],
		loadUserValues: async () => {
			throw new Error('should not run')
		},
	})

	expect(result).toEqual({
		packageRows: [],
		userSecretRows: [],
		userValueRows: [],
		warnings: [],
	})
})

test('down home connector status is returned when the connector is disconnected', async () => {
	const status = await loadDownHomeConnectorStatus({
		env: {
			HOME_CONNECTOR_SESSION: {
				idFromName(name: string) {
					return name
				},
				get() {
					return {
						fetch() {
							return Promise.resolve(Response.json(null))
						},
					}
				},
			},
		} as unknown as Env,
		homeConnectorId: 'default',
	})

	expect(status).toMatchObject({
		state: 'disconnected',
		connectorId: 'default',
		connected: false,
		toolCount: 0,
	})
})

test('down home connector status stays hidden when the connector is up', async () => {
	const status = await loadDownHomeConnectorStatus({
		env: {
			HOME_CONNECTOR_SESSION: {
				idFromName(name: string) {
					return name
				},
				get() {
					return {
						fetch() {
							return Promise.resolve(
								Response.json({
									connectorId: 'default',
									connectedAt: '2026-03-25T00:00:00.000Z',
									lastSeenAt: '2026-03-25T00:00:01.000Z',
									tools: [{ name: 'roku_press_key' }],
								}),
							)
						},
					}
				},
			},
		} as unknown as Env,
		homeConnectorId: 'default',
	})

	expect(status).toBeNull()
})
