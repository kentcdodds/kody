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
	const retrieverResults = [
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
	]
	const directMatch = await searchUnified({
		env: {} as Env,
		query: 'bob phone number',
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
			kodyId: 'personal-inbox',
			retrieverKey: 'notes',
		}),
	])
	expect(directMatch.telemetry.candidateCounts.retriever_result).toBe(1)

	const clampedRanking = await searchUnified({
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
				...retrieverResults[0]!,
				title: 'Unrelated appliance note',
				summary: 'The toaster oven is 1800 watts.',
				score: 50,
			},
		],
	})
	expect(clampedRanking.matches).toEqual(
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

test('optional search rows load packages and values with graceful fallbacks', async () => {
	const emptyRows = {
		packageRows: [],
		userSecretRows: [],
		userValueRows: [],
	}

	const packageFailure = await loadOptionalSearchRows({
		userId: 'user-123',
		loadPackages: async () => {
			throw new Error('packages unavailable')
		},
		loadUserSecrets: async () => [],
		loadUserValues: async () => [],
	})
	expect(packageFailure.packageRows).toEqual([])
	expect(packageFailure.userSecretRows).toEqual([])
	expect(packageFailure.userValueRows).toEqual([])
	expect(packageFailure.warnings).toHaveLength(1)
	expect(packageFailure.warnings[0]).toMatch(/packages unavailable/i)

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

	const packageWarnings = await loadOptionalSearchRows({
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
	expect(packageWarnings.packageRows).toHaveLength(1)
	expect(packageWarnings.warnings).toEqual(['fallback warning'])

	const valuesFailure = await loadOptionalSearchRows({
		userId: 'user-123',
		loadPackages: async () => [],
		loadUserSecrets: async () => [],
		loadUserValues: async () => {
			throw new Error('values unavailable')
		},
	})
	expect(valuesFailure.packageRows).toEqual([])
	expect(valuesFailure.userSecretRows).toEqual([])
	expect(valuesFailure.userValueRows).toEqual([])
	expect(valuesFailure.warnings).toHaveLength(1)
	expect(valuesFailure.warnings[0]).toMatch(/values unavailable/i)

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
	const result = await searchUnified({
		env: {} as Env,
		query: 'google calendar create event',
		limit: 5,
		registry,
		optionalRows: {
			packageRows: [
				{
					record: {
						id: 'google-pkg',
						userId: 'user-1',
						name: '@kentcdodds/google-products',
						kodyId: 'google-products',
						description: 'Google product helpers.',
						tags: ['google', 'calendar'],
						searchText: 'Gmail Calendar Drive helpers',
						sourceId: 'source-google',
						hasApp: false,
						createdAt: '2026-04-20T00:00:00.000Z',
						updatedAt: '2026-04-20T00:00:00.000Z',
					},
					projection: {
						name: '@kentcdodds/google-products',
						kodyId: 'google-products',
						description: 'Google product helpers.',
						tags: ['google', 'calendar'],
						searchText: 'Gmail Calendar Drive helpers',
						hasApp: false,
						appEntry: null,
						exports: [
							createPackageExportProjection('./calendar', {
								description: 'Create a calendar event.',
								functionName: 'createEvent',
								functionDescription: 'Create a calendar event.',
								typeDefinition:
									'export declare function createEvent(params: CalendarEventMutationParams): Promise<JsonObject>',
							}),
							createPackageExportProjection('./gmail', {
								description: 'Search Gmail messages.',
								functionName: 'searchMessages',
								functionDescription: 'Search Gmail messages.',
							}),
						],
						jobs: [],
						services: [],
						subscriptions: [],
						retrievers: [],
					},
				},
			],
			userSecretRows: [],
			userValueRows: [],
		},
	})

	const packageMatch = result.matches[0]
	expect(packageMatch).toMatchObject({
		type: 'package',
		kodyId: 'google-products',
		actionMatches: [
			expect.objectContaining({
				subpath: './calendar',
				functions: [
					expect.objectContaining({
						name: 'createEvent',
					}),
				],
			}),
		],
	})
	const broadQuery = await searchUnified({
		env: {} as Env,
		query: 'google products helpers',
		limit: 5,
		registry,
		optionalRows: {
			packageRows: [
				{
					record: {
						id: 'google-pkg',
						userId: 'user-1',
						name: '@kentcdodds/google-products',
						kodyId: 'google-products',
						description: 'Google product helpers.',
						tags: ['google'],
						searchText: 'Gmail Calendar Drive helpers',
						sourceId: 'source-google',
						hasApp: false,
						createdAt: '2026-04-20T00:00:00.000Z',
						updatedAt: '2026-04-20T00:00:00.000Z',
					},
					projection: {
						name: '@kentcdodds/google-products',
						kodyId: 'google-products',
						description: 'Google product helpers.',
						tags: ['google'],
						searchText: 'Gmail Calendar Drive helpers',
						hasApp: false,
						appEntry: null,
						exports: [
							createPackageExportProjection('./calendar', {
								description: 'Create a calendar event.',
								functionName: 'createEvent',
							}),
						],
						jobs: [],
						services: [],
						subscriptions: [],
						retrievers: [],
					},
				},
			],
			userSecretRows: [],
			userValueRows: [],
		},
	})
	expect(broadQuery.matches[0]).toMatchObject({
		type: 'package',
		kodyId: 'google-products',
		actionMatches: [],
	})
})

test('buildSavedPackageSearchRows hydrates README and export JSDoc search signals', async () => {
	const manifest = parseAuthoredPackageJson({
		content: JSON.stringify({
			name: '@kentcdodds/email-received-subscriber',
			exports: {
				'./trace-processor': {
					import: './src/trace-processor.ts',
					types: './src/trace-processor.d.ts',
				},
			},
			kody: {
				id: 'email-received-subscriber',
				description: 'Email received subscriber package',
			},
		}),
		manifestPath: 'package.json',
	})
	const files = {
		'package.json': '{}',
		'README.md':
			'# Email received subscriber\n\nPackage-first trace and debug workflow for failed email processor service storage automation.',
		'src/trace-processor.d.ts': `/**
 * Trace failed email processor service storage writes.
 */
export declare function traceProcessorFailure(messageId: string): Promise<void>
`,
	}
	sourceMocks.loadPackageSourceBySourceId.mockResolvedValueOnce({
		source: { id: 'source-email' },
		manifest,
		files,
	})

	const rows = await buildSavedPackageSearchRows({
		env: {} as Env,
		baseUrl: 'http://localhost',
		userId: 'user-123',
		records: [
			{
				id: 'email-pkg',
				userId: 'user-123',
				name: '@kentcdodds/email-received-subscriber',
				kodyId: 'email-received-subscriber',
				description: 'Email received subscriber package',
				tags: ['email'],
				searchText: null,
				sourceId: 'source-email',
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
			snippet: expect.stringContaining('trace and debug workflow'),
			truncated: false,
		},
		projection: {
			exports: [
				expect.objectContaining({
					description: 'Trace failed email processor service storage writes.',
				}),
			],
		},
	})

	const registry = buildCapabilityRegistry([
		{
			name: 'email',
			description: 'Email and storage primitives',
			capabilities: [
				{
					name: 'email_storage_query',
					domain: 'email',
					description:
						'Low-level email service storage query for processor records.',
					keywords: ['email', 'storage', 'service', 'processor', 'failed'],
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
		query: 'email trace failed processor service storage',
		limit: 3,
		registry,
		optionalRows: {
			packageRows: rows.rows,
			userSecretRows: [],
			userValueRows: [],
		},
	})

	expect(result.matches[0]).toMatchObject({
		type: 'package',
		kodyId: 'email-received-subscriber',
	})
})

test('buildSavedPackageSearchRows falls back when package source resolution fails', async () => {
	sourceMocks.loadPackageSourceBySourceId.mockRejectedValueOnce(
		new Error('missing-source'),
	)
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
