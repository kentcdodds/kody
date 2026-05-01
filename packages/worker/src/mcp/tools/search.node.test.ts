import { expect, test, vi } from 'vitest'
import { buildCapabilityRegistry } from '#mcp/capabilities/build-capability-registry.ts'
import { synthesizeRemoteToolDomain } from '#mcp/capabilities/home/index.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { buildConnectorValueName } from '#mcp/capabilities/values/connector-shared.ts'
import {
	buildSavedPackageSearchRows,
	loadDownHomeConnectorStatus,
	loadOptionalSearchRows,
	resolveSearchMemoryContext,
	searchUnified,
	type OptionalSearchRowsResult,
	type PackageSearchRow,
} from './search.ts'

function createPackageExportProjection(subpath: string) {
	return {
		subpath,
		runtimeTarget: null,
		typesPath: null,
		description: null,
		typeDefinition: null,
		functions: [],
	}
}

const sourceMocks = vi.hoisted(() => ({
	loadPackageManifestBySourceId: vi.fn(),
	loadPackageSourceBySourceId: vi.fn(),
}))

vi.mock('#worker/package-registry/source.ts', async () => {
	const actual = await vi.importActual<
		typeof import('#worker/package-registry/source.ts')
	>('#worker/package-registry/source.ts')
	return {
		...actual,
		loadPackageManifestBySourceId: (...args: Array<unknown>) =>
			sourceMocks.loadPackageManifestBySourceId(...args),
		loadPackageSourceBySourceId: (...args: Array<unknown>) =>
			sourceMocks.loadPackageSourceBySourceId(...args),
	}
})

test('searchUnified ranks mixed search rows through one shared pipeline', async () => {
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
				appEntry: null,
				exports: [],
				jobs: [],
				services: [],
				subscriptions: [],
				retrievers: [],
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

	const result = await searchUnified({
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
				tokenUrl: 'https://delta.example/token',
				clientIdValueName: 'github-client-id',
				clientSecretSecretName: 'github-client-secret',
				accessTokenSecretName: 'github-access-token',
				refreshTokenSecretName: 'github-refresh-token',
			}),
			expect.objectContaining({
				type: 'secret',
				name: 'alpha-secret',
			}),
		]),
	)
})

test('searchUnified includes package retriever results as first-class matches', async () => {
	const registry = buildCapabilityRegistry([])
	const result = await searchUnified({
		env: {} as Env,
		query: 'bob phone number',
		limit: 5,
		registry,
		optionalRows: {
			packageRows: [],
			userSecretRows: [],
			userValueRows: [],
		},
		retrieverResults: [
			{
				id: 'note-1',
				title: 'Bob phone number',
				summary: 'Bob can be reached at 555-1234.',
				score: 0.9,
				source: 'personal inbox',
				packageId: 'package-1',
				kodyId: 'personal-inbox',
				retrieverKey: 'notes',
				retrieverName: 'Personal inbox notes',
			},
		],
	})

	expect(result.matches).toEqual([
		expect.objectContaining({
			type: 'retriever_result',
			id: 'note-1',
			kodyId: 'personal-inbox',
			retrieverKey: 'notes',
		}),
	])
	expect(result.telemetry.candidateCounts.retriever_result).toBe(1)
})

test('searchUnified clamps package retriever scores into the normal ranking range', async () => {
	const registry = buildCapabilityRegistry([
		{
			name: 'meta',
			description: 'Meta capabilities',
			capabilities: [
				{
					name: 'bob_phone_lookup',
					domain: 'meta',
					description: 'Find Bob phone details',
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
	const result = await searchUnified({
		env: {} as Env,
		query: 'bob phone',
		limit: 2,
		registry,
		optionalRows: {
			packageRows: [],
			userSecretRows: [],
			userValueRows: [],
		},
		retrieverResults: [
			{
				id: 'note-1',
				title: 'Unrelated appliance note',
				summary: 'The toaster oven is 1800 watts.',
				score: 50,
				packageId: 'package-1',
				kodyId: 'personal-inbox',
				retrieverKey: 'notes',
				retrieverName: 'Personal inbox notes',
			},
		],
	})

	expect(result.matches).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				type: 'capability',
				name: 'bob_phone_lookup',
			}),
			expect.objectContaining({
				type: 'retriever_result',
				id: 'note-1',
			}),
		]),
	)
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
			throw new Error('packages unavailable')
		},
		loadUserSecrets: async () => [],
		loadUserValues: async () => [],
	})

	expect(result.packageRows).toEqual([])
	expect(result.userSecretRows).toEqual([])
	expect(result.userValueRows).toEqual([])
	expect(result.warnings).toHaveLength(1)
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
					appEntry: 'src/app.ts',
					exports: [createPackageExportProjection('.')],
					jobs: [],
					services: [],
					subscriptions: [],
					retrievers: [],
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

test('optional search rows preserve package fallback warnings', async () => {
	const result = await loadOptionalSearchRows({
		userId: 'user-123',
		loadPackages: async () => ({
			rows: [
				{
					record: {
						id: 'package-123',
						userId: 'user-123',
						name: '@kody/observed',
						kodyId: 'observed-package',
						description: 'Observed package',
						tags: ['observed'],
						searchText: null,
						sourceId: 'source-package-123',
						hasApp: true,
						createdAt: '2026-03-24T00:00:00.000Z',
						updatedAt: '2026-03-24T00:00:00.000Z',
					},
					projection: {
						name: '@kody/observed',
						kodyId: 'observed-package',
						description: 'Observed package',
						tags: ['observed'],
						searchText: null,
						hasApp: true,
						appEntry: null,
						exports: [],
						jobs: [],
						services: [],
						subscriptions: [],
						retrievers: [],
					},
				},
			],
			warnings: ['fallback warning'],
		}),
		loadUserSecrets: async () => [],
		loadUserValues: async () => [],
	})

	expect(result.packageRows).toHaveLength(1)
	expect(result.warnings).toEqual(['fallback warning'])
})

test('searchUnified ranks related packages and connectors for operate queries', async () => {
	const registry = buildCapabilityRegistry([])
	const optionalRows = {
		packageRows: [
			{
				record: {
					id: 'spotify-pkg',
					userId: 'user-1',
					name: '@kentcdodds/spotify',
					kodyId: 'spotify',
					description:
						'Package-first Spotify playback controls, queue helpers, device management, and a hosted remote app.',
					tags: ['spotify', 'music', 'playback'],
					searchText: 'spotify remote playback package music queue player',
					sourceId: 'source-spotify',
					hasApp: true,
					createdAt: '2026-04-20T00:00:00.000Z',
					updatedAt: '2026-04-20T00:00:00.000Z',
				},
				projection: {
					name: '@kentcdodds/spotify',
					kodyId: 'spotify',
					description:
						'Package-first Spotify playback controls, queue helpers, device management, and a hosted remote app.',
					tags: ['spotify', 'music', 'playback'],
					searchText: 'spotify remote playback package music queue player',
					hasApp: true,
					appEntry: 'src/app/server.ts',
					exports: [
						createPackageExportProjection('./playback-state'),
						createPackageExportProjection('./play-pause'),
						createPackageExportProjection('./transfer-playback'),
						createPackageExportProjection('./add-to-queue'),
						createPackageExportProjection('./playback-controller'),
					],
					jobs: [],
					services: [],
					subscriptions: [],
					retrievers: [],
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
					flow: 'pkce',
					clientIdValueName: 'spotify-client-id',
					clientSecretSecretName: null,
					accessTokenSecretName: 'spotify-access-token',
					refreshTokenSecretName: 'spotify-refresh-token',
					requiredHosts: ['api.spotify.com'],
				}),
				description: 'Spotify playback and music OAuth connector config',
				appId: null,
				createdAt: '2026-04-20T00:00:00.000Z',
				updatedAt: '2026-04-20T00:00:00.000Z',
				ttlMs: null,
			},
		],
		warnings: [],
	} satisfies OptionalSearchRowsResult

	const result = await searchUnified({
		env: {} as Env,
		query: 'play a lofi song on spotify',
		limit: 5,
		registry,
		optionalRows,
	})

	expect(result.matches).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				type: 'package',
				kodyId: 'spotify',
			}),
			expect.objectContaining({
				type: 'connector',
				connectorName: 'spotify',
			}),
		]),
	)
	expect(result.matches[0]).toMatchObject({
		type: 'package',
		kodyId: 'spotify',
	})
})

test('buildSavedPackageSearchRows falls back when package source resolution fails', async () => {
	const result = await buildSavedPackageSearchRows({
		env: {} as Env,
		baseUrl: 'http://localhost',
		userId: 'user-123',
		records: [
			{
				id: 'package-123',
				userId: 'user-123',
				name: '@kody/observed',
				kodyId: 'observed',
				description: 'Observed package',
				tags: ['observed'],
				searchText: 'search text',
				sourceId: 'missing-source',
				hasApp: true,
				createdAt: '2026-03-24T00:00:00.000Z',
				updatedAt: '2026-03-24T00:00:00.000Z',
			},
		],
	})

	expect(result.rows).toEqual([
		expect.objectContaining({
			projection: expect.objectContaining({
				hasApp: true,
				appEntry: null,
				exports: [],
				jobs: [],
				services: [],
			}),
		}),
	])
	expect(result.warnings).toHaveLength(1)
})

test('search guidance does not pair unrelated package and connector matches', async () => {
	const registry = buildCapabilityRegistry([])
	const result = await searchUnified({
		env: {} as Env,
		query: 'music remote',
		limit: 5,
		registry,
		optionalRows: {
			packageRows: [
				{
					record: {
						id: 'package-123',
						userId: 'user-123',
						name: '@kody/observed',
						kodyId: 'observed-package',
						description: 'Observed package with app controls.',
						tags: ['music'],
						searchText: 'music remote package',
						sourceId: 'source-package-123',
						hasApp: true,
						createdAt: '2026-03-24T00:00:00.000Z',
						updatedAt: '2026-03-24T00:00:00.000Z',
					},
					projection: {
						name: '@kody/observed',
						kodyId: 'observed-package',
						description: 'Observed package with app controls.',
						tags: ['music'],
						searchText: 'music remote package',
						hasApp: true,
						appEntry: 'src/app.ts',
						exports: [createPackageExportProjection('./play')],
						jobs: [],
						services: [],
						subscriptions: [],
						retrievers: [],
					},
				},
			],
			userSecretRows: [],
			userValueRows: [
				{
					name: buildConnectorValueName('github'),
					scope: 'user',
					value: JSON.stringify({
						tokenUrl: 'https://github.com/login/oauth/access_token',
						apiBaseUrl: 'https://api.github.com',
						flow: 'confidential',
						clientIdValueName: 'github-client-id',
						clientSecretSecretName: 'github-client-secret',
						accessTokenSecretName: 'github-access-token',
						refreshTokenSecretName: 'github-refresh-token',
						requiredHosts: ['api.github.com'],
					}),
					description: 'GitHub OAuth connector config',
					appId: null,
					createdAt: '2026-04-20T00:00:00.000Z',
					updatedAt: '2026-04-20T00:00:00.000Z',
					ttlMs: null,
				},
			],
			warnings: [],
		},
	})

	expect(result.matches[0]).toMatchObject({
		type: 'package',
		kodyId: 'observed-package',
	})
	expect(result.guidance).toBeDefined()
})

const runtimeLutronTools = [
	{
		name: 'lutron_set_zone_color',
		title: 'Set Lutron Zone Color',
		description: 'Set a Lutron lighting zone to a specific color.',
		inputSchema: {
			type: 'object',
			properties: {
				zoneId: { type: 'string' },
				red: { type: 'number' },
				green: { type: 'number' },
				blue: { type: 'number' },
			},
			required: ['zoneId', 'red', 'green', 'blue'],
		},
	},
	{
		name: 'lutron_set_zone_level',
		title: 'Set Lutron Zone Level',
		description: 'Set a Lutron lighting zone brightness level.',
		inputSchema: {
			type: 'object',
			properties: {
				zoneId: { type: 'string' },
				percent: { type: 'number' },
			},
			required: ['zoneId', 'percent'],
		},
	},
	{
		name: 'lutron_set_zone_white_tuning',
		title: 'Set Lutron Zone White Tuning',
		description: 'Adjust a tunable white Lutron lighting zone.',
		inputSchema: {
			type: 'object',
			properties: {
				zoneId: { type: 'string' },
				kelvin: { type: 'number' },
			},
			required: ['zoneId', 'kelvin'],
		},
	},
] as const

async function buildHomeRegistryWithLutronCapabilities() {
	const env = {
		SENTRY_ENVIRONMENT: 'test',
		HOME_CONNECTOR_SESSION: {
			idFromName(name: string) {
				return name
			},
			get() {
				return {
					getSnapshot() {
						return Promise.resolve({
							connectorId: 'default',
							connectedAt: '2026-03-25T00:00:00.000Z',
							lastSeenAt: '2026-03-25T00:00:01.000Z',
							tools: runtimeLutronTools,
						})
					},
				}
			},
		},
	} as unknown as Env
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		homeConnectorId: 'default',
	})
	const synthesized = await synthesizeRemoteToolDomain(
		env,
		{ kind: 'home', instanceId: 'default' },
		[{ kind: 'home', instanceId: 'default' }],
	)
	if (!synthesized) throw new Error('Expected synthesized Lutron home domain')
	return {
		env,
		registry: buildCapabilityRegistry([synthesized.domain]),
		callerContext,
	}
}

test('searchUnified surfaces home_lutron_set_zone_color for literal lutron queries', async () => {
	const { env, registry } = await buildHomeRegistryWithLutronCapabilities()

	const result = await searchUnified({
		env,
		query: 'lutron lights color',
		limit: 5,
		registry,
		optionalRows: {
			packageRows: [],
			userSecretRows: [],
			userValueRows: [],
		},
	})

	expect(result.matches[0]).toMatchObject({
		type: 'capability',
		name: 'home_lutron_set_zone_color',
	})
})

test('searchUnified keeps home_lutron_set_zone_color near the top for intent-like home lighting queries', async () => {
	const { env, registry } = await buildHomeRegistryWithLutronCapabilities()

	const result = await searchUnified({
		env,
		query: 'turn office lights red',
		limit: 5,
		registry,
		optionalRows: {
			packageRows: [],
			userSecretRows: [],
			userValueRows: [],
		},
	})

	expect(
		result.matches
			.filter(
				(match): match is Extract<typeof match, { type: 'capability' }> =>
					match.type === 'capability',
			)
			.slice(0, 3),
	).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				name: 'home_lutron_set_zone_color',
			}),
		]),
	)
})

test('optional search rows fall back when persisted values lookup fails', async () => {
	const result = await loadOptionalSearchRows({
		userId: 'user-123',
		loadPackages: async () => [],
		loadUserSecrets: async () => [],
		loadUserValues: async () => {
			throw new Error('values unavailable')
		},
	})

	expect(result.packageRows).toEqual([])
	expect(result.userSecretRows).toEqual([])
	expect(result.userValueRows).toEqual([])
	expect(result.warnings).toHaveLength(1)
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
						getSnapshot() {
							return Promise.resolve(null)
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
						getSnapshot() {
							return Promise.resolve({
								connectorId: 'default',
								connectedAt: '2026-03-25T00:00:00.000Z',
								lastSeenAt: '2026-03-25T00:00:01.000Z',
								tools: [{ name: 'roku_press_key' }],
							})
						},
					}
				},
			},
		} as unknown as Env,
		homeConnectorId: 'default',
	})

	expect(status).toBeNull()
})
