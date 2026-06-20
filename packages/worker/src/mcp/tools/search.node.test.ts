import { expect, test, vi } from 'vitest'
import { buildCapabilityRegistry } from '#mcp/capabilities/build-capability-registry.ts'
import { buildIntegrationValueName } from '#mcp/capabilities/values/integration-shared.ts'
import type * as PackageRegistrySource from '#worker/package-registry/source.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import {
	buildSavedPackageSearchRows,
	loadDownRemoteConnectorStatuses,
	loadOptionalSearchRows,
	searchUnified,
	type OptionalSearchRowsResult,
	type PackageSearchRow,
} from './search.ts'

function createPackageExportProjection(
	subpath: string,
	options: {
		description?: string
		typeDefinition?: string
		functionName?: string
		functionDescription?: string
	} = {},
) {
	return {
		subpath,
		runtimeTarget: null,
		typesPath: null,
		description: options.description ?? null,
		typeDefinition: options.typeDefinition ?? null,
		functions: options.functionName
			? [
					{
						name: options.functionName,
						description: options.functionDescription ?? null,
						typeDefinition: options.typeDefinition ?? null,
						referencedTypes: [],
					},
				]
			: [],
		referencedTypes: [],
	}
}

const sourceMocks = vi.hoisted(() => ({
	loadPackageSourceBySourceId: vi.fn(),
}))

vi.mock('#worker/package-registry/source.ts', async () => {
	const actual = await vi.importActual<typeof PackageRegistrySource>(
		'#worker/package-registry/source.ts',
	)
	return {
		...actual,
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
				name: buildIntegrationValueName('github'),
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
				description: 'alpha beta gamma integration',
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
				type: 'integration',
				integrationName: 'github',
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

test('searchUnified ranks package retriever results alongside capabilities', async () => {
	const registry = buildCapabilityRegistry([
		{
			name: 'meta',
			description: 'Meta capabilities',
			capabilities: [
				{
					name: 'target_lookup',
					domain: 'meta',
					description: 'Find target details',
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
	const retrieverResults = [
		{
			id: 'note-1',
			title: 'Target lookup note',
			summary: 'Target can be reached at 555-1234.',
			score: 0.9,
			source: 'notes inbox',
			packageId: 'package-1',
			kodyId: 'notes-package',
			retrieverKey: 'notes',
			retrieverName: 'Notes retriever',
		},
	]
	const directMatch = await searchUnified({
		env: {} as Env,
		query: 'target lookup note',
		limit: 5,
		registry: buildCapabilityRegistry([]),
		optionalRows: {
			packageRows: [],
			userSecretRows: [],
			userValueRows: [],
		},
		retrieverResults,
	})
	expect(directMatch.matches).toEqual([
		expect.objectContaining({
			type: 'retriever_result',
			id: 'note-1',
			kodyId: 'notes-package',
			retrieverKey: 'notes',
		}),
	])
	expect(directMatch.telemetry.candidateCounts.retriever_result).toBe(1)

	const mixedRanking = await searchUnified({
		env: {} as Env,
		query: 'target lookup',
		limit: 2,
		registry,
		optionalRows: {
			packageRows: [],
			userSecretRows: [],
			userValueRows: [],
		},
		retrieverResults: [
			{
				...retrieverResults[0]!,
				title: 'Unrelated appliance note',
				summary: 'The appliance is 1800 watts.',
				score: 50,
			},
		],
	})
	expect(mixedRanking.matches).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				type: 'capability',
				name: 'target_lookup',
			}),
			expect.objectContaining({
				type: 'retriever_result',
				id: 'note-1',
			}),
		]),
	)
})

test('optional search rows load packages and values without partial fallbacks', async () => {
	const emptyRows = {
		packageRows: [],
		userSecretRows: [],
		userValueRows: [],
	}

	await expect(
		loadOptionalSearchRows({
			userId: 'user-123',
			loadPackages: async () => {
				throw new Error('packages unavailable')
			},
			loadUserSecrets: async () => [],
			loadUserValues: async () => [],
		}),
	).rejects.toThrow('packages unavailable')

	const savedPackage = await loadOptionalSearchRows({
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
	expect(savedPackage.packageRows).toHaveLength(1)
	expect(savedPackage.packageRows[0]?.record.kodyId).toBe('roku-remote')
	expect(savedPackage.userSecretRows).toEqual([])
	expect(savedPackage.userValueRows).toEqual([])
	expect(savedPackage.warnings).toEqual([])

	await expect(
		loadOptionalSearchRows({
			userId: 'user-123',
			loadPackages: async () => [],
			loadUserSecrets: async () => [],
			loadUserValues: async () => {
				throw new Error('values unavailable')
			},
		}),
	).rejects.toThrow('values unavailable')

	const anonymous = await loadOptionalSearchRows({
		userId: null,
		loadPackages: async () => {
			throw new Error('should not run')
		},
		loadUserSecrets: async () => [],
		loadUserValues: async () => {
			throw new Error('should not run')
		},
	})
	expect(anonymous).toEqual({
		...emptyRows,
		warnings: [],
	})
})

test('searchUnified annotates high-confidence package action matches', async () => {
	const registry = buildCapabilityRegistry([])
	const packageRow = {
		record: {
			id: 'pkg-alpha',
			userId: 'user-1',
			name: '@kody/pkg-alpha',
			kodyId: 'pkg-alpha',
			description: 'Alpha helpers.',
			tags: ['alpha', 'module-a'],
			searchText: 'module-a module-b helpers',
			sourceId: 'source-alpha',
			hasApp: false,
			createdAt: '2026-04-20T00:00:00.000Z',
			updatedAt: '2026-04-20T00:00:00.000Z',
		},
		projection: {
			name: '@kody/pkg-alpha',
			kodyId: 'pkg-alpha',
			description: 'Alpha helpers.',
			tags: ['alpha', 'module-a'],
			searchText: 'module-a module-b helpers',
			hasApp: false,
			appEntry: null,
			exports: [
				createPackageExportProjection('./module-a', {
					description: 'Run module-a task.',
					functionName: 'runTask',
					functionDescription: 'Run module-a task.',
					typeDefinition:
						'export declare function runTask(params: TaskParams): Promise<JsonObject>',
				}),
				createPackageExportProjection('./module-b', {
					description: 'Search module-b records.',
					functionName: 'searchRecords',
					functionDescription: 'Search module-b records.',
				}),
			],
			jobs: [],
			services: [],
			subscriptions: [],
			retrievers: [],
		},
	}
	const result = await searchUnified({
		env: {} as Env,
		query: 'module-a run task',
		limit: 5,
		registry,
		optionalRows: {
			packageRows: [packageRow],
			userSecretRows: [],
			userValueRows: [],
		},
	})

	const packageMatch = result.matches.find((match) => match.type === 'package')
	expect(packageMatch).toMatchObject({
		type: 'package',
		kodyId: 'pkg-alpha',
	})
	expect(packageMatch?.actionMatches).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				subpath: './module-a',
				functions: [
					expect.objectContaining({
						name: 'runTask',
					}),
				],
			}),
		]),
	)
	const broadQuery = await searchUnified({
		env: {} as Env,
		query: 'alpha helpers overview',
		limit: 5,
		registry,
		optionalRows: {
			packageRows: [
				{
					...packageRow,
					projection: {
						...packageRow.projection,
						exports: [
							createPackageExportProjection('./module-a', {
								description: 'Run module-a task.',
								functionName: 'runTask',
							}),
						],
					},
				},
			],
			userSecretRows: [],
			userValueRows: [],
		},
	})
	const broadPackageMatch = broadQuery.matches.find(
		(match) => match.type === 'package',
	)
	expect(broadPackageMatch).toMatchObject({
		type: 'package',
		kodyId: 'pkg-alpha',
		actionMatches: [],
	})
})

test('buildSavedPackageSearchRows hydrates README and export JSDoc search signals', async () => {
	const readmeBody =
		'Package-first trace and debug workflow for failed processor service storage automation.'
	const exportDescription = 'Trace failed processor service storage writes.'
	const manifest = parseAuthoredPackageJson({
		content: JSON.stringify({
			name: '@kody/trace-package',
			exports: {
				'./trace-processor': {
					import: './src/trace-processor.ts',
					types: './src/trace-processor.d.ts',
				},
			},
			kody: {
				id: 'trace-package',
				description: 'Trace package',
			},
		}),
		manifestPath: 'package.json',
	})
	const files = {
		'package.json': '{}',
		'README.md': `# Trace package\n\n${readmeBody}`,
		'src/trace-processor.d.ts': `/**
 * ${exportDescription}
 */
export declare function traceProcessorFailure(messageId: string): Promise<void>
`,
	}
	sourceMocks.loadPackageSourceBySourceId.mockResolvedValueOnce({
		source: { id: 'source-trace' },
		manifest,
		files,
	})

	const rows = await buildSavedPackageSearchRows({
		env: {} as Env,
		baseUrl: 'http://localhost',
		userId: 'user-123',
		records: [
			{
				id: 'trace-pkg',
				userId: 'user-123',
				name: '@kody/trace-package',
				kodyId: 'trace-package',
				description: 'Trace package',
				tags: ['trace'],
				searchText: null,
				sourceId: 'source-trace',
				hasApp: false,
				createdAt: '2026-04-20T00:00:00.000Z',
				updatedAt: '2026-04-20T00:00:00.000Z',
			},
		],
	})

	expect(rows.warnings).toEqual([])
	expect(rows.rows[0]).toMatchObject({
		readmeSnippet: {
			path: 'README.md',
			snippet: expect.stringContaining(readmeBody),
			truncated: false,
		},
		projection: {
			exports: [
				expect.objectContaining({
					description: exportDescription,
				}),
			],
		},
	})

	const registry = buildCapabilityRegistry([
		{
			name: 'storage',
			description: 'Storage primitives',
			capabilities: [
				{
					name: 'storage_query',
					domain: 'storage',
					description: 'Low-level storage query for processor records.',
					keywords: ['storage', 'service', 'processor', 'failed'],
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
		query: 'trace failed processor service storage',
		limit: 3,
		registry,
		optionalRows: {
			packageRows: rows.rows,
			userSecretRows: [],
			userValueRows: [],
		},
	})

	expect(result.matches).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				type: 'package',
				kodyId: 'trace-package',
			}),
		]),
	)
})

test('buildSavedPackageSearchRows rejects when package source resolution fails', async () => {
	sourceMocks.loadPackageSourceBySourceId.mockRejectedValueOnce(
		new Error('missing-source'),
	)
	await expect(
		buildSavedPackageSearchRows({
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
		}),
	).rejects.toThrow('missing-source')
})

test('down remote connector statuses surface only disconnected connectors for signed-in users', async () => {
	const signedInContext = {
		user: {
			userId: 'user-1',
			email: 'user-1@example.com',
			displayName: 'user-1',
		},
		remoteConnectors: [{ kind: 'lights', instanceId: 'default' }],
	}
	const disconnected = await loadDownRemoteConnectorStatuses({
		env: {
			REMOTE_CONNECTOR_SESSION: {
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
		callerContext: signedInContext,
	})
	expect(disconnected).toEqual([
		expect.objectContaining({
			state: 'disconnected',
			connectorId: 'default',
			connected: false,
			toolCount: 0,
		}),
	])

	const connected = await loadDownRemoteConnectorStatuses({
		env: {
			REMOTE_CONNECTOR_SESSION: {
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
		callerContext: signedInContext,
	})
	expect(connected).toEqual([])

	const anonymous = await loadDownRemoteConnectorStatuses({
		env: {} as unknown as Env,
		callerContext: {
			remoteConnectors: [{ kind: 'lights', instanceId: 'default' }],
		},
	})
	expect(anonymous).toEqual([])
})
