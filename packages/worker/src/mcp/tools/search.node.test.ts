import { expect, test } from 'vitest'
import { buildCapabilityRegistry } from '#mcp/capabilities/build-capability-registry.ts'
import { buildConnectorValueName } from '#mcp/capabilities/values/connector-shared.ts'
import {
	loadDownHomeConnectorStatus,
	loadOptionalSearchRows,
	resolveSearchMemoryContext,
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
	expect(result.matches[0]).toMatchObject({
		type: 'package',
		packageId: 'pkg-1',
	})
	expect(result.matches).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				type: 'capability',
				name: 'alpha beta',
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
