import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { buildCapabilityRegistry } from '#mcp/capabilities/build-capability-registry.ts'
import {
	CAPABILITY_EMBEDDING_DIMENSIONS,
	deterministicEmbedding,
} from '#mcp/capabilities/capability-search.ts'
import { filterCapabilityRegistryForCaller } from '#mcp/capabilities/access-control.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { buildIntegrationValueName } from '#mcp/capabilities/integrations/integration-shared.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
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

function buildRoleGatedSearchRegistry() {
	const publicCapability = defineDomainCapability('meta', {
		name: 'public_docs_search',
		description: 'Search public docs',
		keywords: ['public', 'docs', 'search'],
		readOnly: true,
		idempotent: true,
		inputSchema: {
			type: 'object',
			properties: {},
		},
		handler: async () => null,
	})
	const adminCapability = defineDomainCapability('admin', {
		name: 'admin_user_list',
		description: 'List admin user account metadata and roles',
		keywords: ['admin', 'users', 'roles', 'accounts'],
		readOnly: true,
		idempotent: true,
		requiredRole: 'admin',
		inputSchema: {
			type: 'object',
			properties: {},
		},
		handler: async () => null,
	})
	return buildCapabilityRegistry([
		{
			name: 'admin',
			description: 'Admin capabilities',
			capabilities: [adminCapability],
		},
		{
			name: 'meta',
			description: 'Meta capabilities',
			capabilities: [publicCapability],
		},
	])
}

const emptyOptionalSearchRows = {
	packageRows: [],
	userSecretRows: [],
	userValueRows: [],
} satisfies Pick<
	OptionalSearchRowsResult,
	'packageRows' | 'userSecretRows' | 'userValueRows'
>

function createDeterministicAiBinding(): Ai {
	return {
		async run(...args: Array<unknown>) {
			const input = args[1] as { text?: unknown }
			const texts = Array.isArray(input.text)
				? input.text.map(String)
				: [String(input.text ?? '')]
			return {
				data: texts.map((text) => deterministicEmbedding(text)),
				shape: [texts.length, CAPABILITY_EMBEDDING_DIMENSIONS],
			}
		},
	} as unknown as Ai
}

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
				hidden: false,
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
				hidden: false,
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

test('searchUnified hides admin capabilities from non-admins in offline search', async () => {
	const registry = buildRoleGatedSearchRegistry()
	const regularRegistry = filterCapabilityRegistryForCaller(
		registry,
		createMcpCallerContext({
			baseUrl: 'https://example.com',
			user: {
				userId: 'user-1',
				email: 'user@example.com',
				displayName: 'user',
				roles: ['user'],
			},
		}),
	)
	const adminRegistry = filterCapabilityRegistryForCaller(
		registry,
		createMcpCallerContext({
			baseUrl: 'https://example.com',
			user: {
				userId: 'admin-1',
				email: 'admin@example.com',
				displayName: 'admin',
				roles: ['admin'],
			},
		}),
	)

	const regularResult = await searchUnified({
		env: { SENTRY_ENVIRONMENT: 'test' } as Env,
		query: 'admin users roles',
		limit: 5,
		registry: regularRegistry,
		optionalRows: emptyOptionalSearchRows,
	})
	const adminResult = await searchUnified({
		env: { SENTRY_ENVIRONMENT: 'test' } as Env,
		query: 'admin users roles',
		limit: 5,
		registry: adminRegistry,
		optionalRows: emptyOptionalSearchRows,
	})

	expect(
		regularResult.matches.some(
			(match) =>
				match.type === 'capability' && match.name === 'admin_user_list',
		),
	).toBe(false)
	expect(
		adminResult.matches.some(
			(match) =>
				match.type === 'capability' && match.name === 'admin_user_list',
		),
	).toBe(true)
})

test('searchUnified hides admin capabilities from non-admins in Vectorize-backed search', async () => {
	const registry = buildRoleGatedSearchRegistry()
	const regularRegistry = filterCapabilityRegistryForCaller(
		registry,
		createMcpCallerContext({
			baseUrl: 'https://example.com',
			user: {
				userId: 'user-1',
				email: 'user@example.com',
				displayName: 'user',
				roles: ['user'],
			},
		}),
	)
	const env = {
		SENTRY_ENVIRONMENT: 'production',
		AI: createDeterministicAiBinding(),
		CAPABILITY_VECTOR_INDEX: {
			async query() {
				return {
					matches: [
						{ id: 'admin_user_list', score: 0.99 },
						{ id: 'public_docs_search', score: 0.5 },
					],
				}
			},
		},
	} as unknown as Env

	const result = await searchUnified({
		env,
		query: 'admin users roles',
		limit: 5,
		registry: regularRegistry,
		optionalRows: emptyOptionalSearchRows,
	})

	expect(result.offline).toBe(false)
	expect(
		result.matches.some(
			(match) =>
				match.type === 'capability' && match.name === 'admin_user_list',
		),
	).toBe(false)
	expect(
		result.matches.some(
			(match) =>
				match.type === 'capability' && match.name === 'public_docs_search',
		),
	).toBe(true)
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
					hidden: false,
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
					hidden: false,
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
			hidden: false,
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
			hidden: false,
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

test('buildSavedPackageSearchRows defers source loading and hydrates only top matches', async () => {
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
	sourceMocks.loadPackageSourceBySourceId.mockClear()
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
				hidden: false,
				createdAt: '2026-04-20T00:00:00.000Z',
				updatedAt: '2026-04-20T00:00:00.000Z',
			},
		],
	})

	// Building rows only projects cheap D1 fields; no source snapshots load.
	expect(rows.warnings).toEqual([])
	expect(sourceMocks.loadPackageSourceBySourceId).not.toHaveBeenCalled()
	expect(rows.rows[0]).toMatchObject({
		readmeSnippet: null,
		projection: expect.objectContaining({
			kodyId: 'trace-package',
			exports: [],
		}),
	})

	const result = await searchUnified({
		env: {} as Env,
		query: 'trace package',
		limit: 3,
		registry: buildCapabilityRegistry([]),
		optionalRows: {
			packageRows: rows.rows,
			userSecretRows: [],
			userValueRows: [],
		},
	})

	// The returned top match is hydrated with README and export metadata.
	const packageMatch = result.matches.find((match) => match.type === 'package')
	expect(packageMatch).toMatchObject({
		type: 'package',
		kodyId: 'trace-package',
		readmeSnippet: {
			path: 'README.md',
			snippet: expect.stringContaining(readmeBody),
			truncated: false,
		},
	})
	expect(packageMatch?.actionMatches).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				subpath: './trace-processor',
				functions: [
					expect.objectContaining({
						name: 'traceProcessorFailure',
					}),
				],
			}),
		]),
	)
	expect(sourceMocks.loadPackageSourceBySourceId).toHaveBeenCalledTimes(1)

	// Hydration failures degrade to the lean match instead of failing search.
	consoleWarn.mockImplementation(() => {})
	sourceMocks.loadPackageSourceBySourceId.mockRejectedValueOnce(
		new Error('missing-source'),
	)
	const failedHydration = await buildSavedPackageSearchRows({
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
				hidden: false,
				createdAt: '2026-03-24T00:00:00.000Z',
				updatedAt: '2026-03-24T00:00:00.000Z',
			},
		],
	})
	const degraded = await searchUnified({
		env: {} as Env,
		query: 'observed package',
		limit: 3,
		registry: buildCapabilityRegistry([]),
		optionalRows: {
			packageRows: failedHydration.rows,
			userSecretRows: [],
			userValueRows: [],
		},
	})
	expect(degraded.matches).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				type: 'package',
				kodyId: 'observed',
				readmeSnippet: null,
			}),
		]),
	)
	// The degraded path leaves a hydration-failure trail for the package.
	expect(consoleWarn).toHaveBeenCalledWith(
		expect.stringContaining('package-123'),
	)
})

test('searchUnified ranks packages via user-filtered package vectors when Vectorize is online', async () => {
	const capturedFilters: Array<Record<string, unknown> | undefined> = []
	const env = {
		SENTRY_ENVIRONMENT: 'production',
		AI: createDeterministicAiBinding(),
		CAPABILITY_VECTOR_INDEX: {
			async query(
				_values: Array<number>,
				options: { filter?: Record<string, unknown> },
			) {
				capturedFilters.push(options.filter)
				const kind = (options.filter as { kind?: { $eq?: string } } | undefined)
					?.kind?.$eq
				if (kind === 'package') {
					return { matches: [{ id: 'package_pkg-vector', score: 0.91 }] }
				}
				return { matches: [] }
			},
		},
	} as unknown as Env
	function leanPackageRow(id: string, name: string): PackageSearchRow {
		return {
			record: {
				id,
				userId: 'user-1',
				name,
				kodyId: name,
				description: 'automation helpers',
				tags: [],
				searchText: null,
				sourceId: `source-${id}`,
				hasApp: false,
				hidden: false,
				createdAt: '2026-04-20T00:00:00.000Z',
				updatedAt: '2026-04-20T00:00:00.000Z',
			},
			projection: {
				name,
				kodyId: name,
				description: 'automation helpers',
				tags: [],
				searchText: null,
				hasApp: false,
				hidden: false,
				appEntry: null,
				exports: [],
				jobs: [],
				services: [],
				subscriptions: [],
				retrievers: [],
			},
			readmeSnippet: null,
		}
	}

	const result = await searchUnified({
		env,
		query: 'summarize inbox threads',
		limit: 5,
		registry: buildCapabilityRegistry([]),
		optionalRows: {
			packageRows: [
				leanPackageRow('pkg-vector', 'semantic-match'),
				leanPackageRow('pkg-other', 'unrelated-package'),
			],
			userSecretRows: [],
			userValueRows: [],
		},
	})

	expect(result.offline).toBe(false)
	expect(capturedFilters).toContainEqual(
		expect.objectContaining({
			kind: { $eq: 'package' },
			userId: { $eq: 'user-1' },
		}),
	)
	expect(
		result.matches.some(
			(match) => match.type === 'package' && match.packageId === 'pkg-vector',
		),
	).toBe(true)
	expect(
		result.matches.some(
			(match) => match.type === 'package' && match.packageId === 'pkg-other',
		),
	).toBe(false)
})

test('searchUnified degrades to lexical package ranking when the vector query throws', async () => {
	consoleWarn.mockImplementation(() => {})
	let packageVectorQueryAttempts = 0
	const env = {
		SENTRY_ENVIRONMENT: 'production',
		AI: createDeterministicAiBinding(),
		CAPABILITY_VECTOR_INDEX: {
			async query(
				_values: Array<number>,
				options: { filter?: Record<string, unknown> },
			) {
				const kind = (options.filter as { kind?: { $eq?: string } } | undefined)
					?.kind?.$eq
				if (kind === 'package') {
					packageVectorQueryAttempts += 1
					throw new Error('vectorize unavailable')
				}
				return { matches: [] }
			},
		},
	} as unknown as Env
	const packageRow: PackageSearchRow = {
		record: {
			id: 'pkg-inbox',
			userId: 'user-1',
			name: 'inbox-summarizer',
			kodyId: 'inbox-summarizer',
			description: 'summarize inbox threads',
			tags: [],
			searchText: null,
			sourceId: 'source-pkg-inbox',
			hasApp: false,
			hidden: false,
			createdAt: '2026-04-20T00:00:00.000Z',
			updatedAt: '2026-04-20T00:00:00.000Z',
		},
		projection: {
			name: 'inbox-summarizer',
			kodyId: 'inbox-summarizer',
			description: 'summarize inbox threads',
			tags: [],
			searchText: null,
			hasApp: false,
			hidden: false,
			appEntry: null,
			exports: [],
			jobs: [],
			services: [],
			subscriptions: [],
			retrievers: [],
		},
		readmeSnippet: null,
	}

	const result = await searchUnified({
		env,
		query: 'summarize inbox threads',
		limit: 5,
		registry: buildCapabilityRegistry([]),
		optionalRows: {
			packageRows: [packageRow],
			userSecretRows: [],
			userValueRows: [],
		},
	})

	expect(result.offline).toBe(false)
	expect(packageVectorQueryAttempts).toBe(1)
	expect(
		result.matches.some(
			(match) => match.type === 'package' && match.packageId === 'pkg-inbox',
		),
	).toBe(true)
	// The degradation leaves a warn trail carrying the vector failure.
	expect(consoleWarn).toHaveBeenCalledWith(
		expect.stringContaining('vectorize unavailable'),
	)
})

test('down remote connector statuses surface only disconnected connectors for signed-in users', async () => {
	const signedInContext = {
		user: {
			userId: 'user-1',
			email: 'user-1@example.com',
			displayName: 'user-1',
		},
		remoteConnectors: [{ instanceId: 'home' }],
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
			connectorId: 'home',
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
								connectorId: 'home',
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
			remoteConnectors: [{ instanceId: 'home' }],
		},
	})
	expect(anonymous).toEqual([])
})

test('searchUnified inlines call shapes for the top three capability matches only', async () => {
	const longTypeBody = Array.from(
		{ length: 40 },
		(_, index) => `field${String(index)}: string`,
	).join('; ')
	const registry = buildCapabilityRegistry([
		{
			name: 'openapi:widgets',
			description: 'Widget OpenAPI ops',
			capabilities: [
				{
					name: 'openapi:widgets:createwidget',
					domain: 'openapi:widgets',
					description: 'Create a widget export job.',
					keywords: ['widget', 'create', 'export'],
					readOnly: false,
					idempotent: false,
					destructive: false,
					source: 'openapi',
					openApi: {
						bindingName: 'widgets',
						kodyName: 'widgets',
						operationSlug: 'createwidget',
						method: 'post',
						path: '/widgets',
					},
					inputSchema: {
						type: 'object',
						properties: { name: { type: 'string' } },
						required: ['name'],
					},
					inputTypeDefinition: `type CreateWidgetInput = { ${longTypeBody} }`,
					handler: async () => null,
				},
				{
					name: 'openapi:widgets:getwidget',
					domain: 'openapi:widgets',
					description: 'Get a widget export job.',
					keywords: ['widget', 'get', 'export'],
					readOnly: true,
					idempotent: true,
					destructive: false,
					source: 'openapi',
					openApi: {
						bindingName: 'widgets',
						kodyName: 'widgets',
						operationSlug: 'getwidget',
						method: 'get',
						path: '/widgets/{id}',
					},
					inputSchema: {
						type: 'object',
						properties: { id: { type: 'string' } },
						required: ['id'],
					},
					inputTypeDefinition: 'type GetWidgetInput = { id: string }',
					handler: async () => null,
				},
				{
					name: 'openapi:widgets:listwidgets',
					domain: 'openapi:widgets',
					description: 'List widget export jobs.',
					keywords: ['widget', 'list', 'export'],
					readOnly: true,
					idempotent: true,
					destructive: false,
					source: 'openapi',
					openApi: {
						bindingName: 'widgets',
						kodyName: 'widgets',
						operationSlug: 'listwidgets',
						method: 'get',
						path: '/widgets',
					},
					inputSchema: { type: 'object', properties: {} },
					inputTypeDefinition: 'type ListWidgetsInput = Record<string, never>',
					handler: async () => null,
				},
				{
					name: 'openapi:widgets:deletewidget',
					domain: 'openapi:widgets',
					description: 'Delete a widget export job.',
					keywords: ['widget', 'delete', 'export'],
					readOnly: false,
					idempotent: true,
					destructive: true,
					source: 'openapi',
					openApi: {
						bindingName: 'widgets',
						kodyName: 'widgets',
						operationSlug: 'deletewidget',
						method: 'delete',
						path: '/widgets/{id}',
					},
					inputSchema: {
						type: 'object',
						properties: { id: { type: 'string' } },
						required: ['id'],
					},
					inputTypeDefinition: 'type DeleteWidgetInput = { id: string }',
					handler: async () => null,
				},
			],
		},
	])

	const result = await searchUnified({
		env: {} as Env,
		query: 'create widget export job',
		limit: 10,
		registry,
		optionalRows: emptyOptionalSearchRows,
	})

	const capabilityMatches = result.matches.filter(
		(match) => match.type === 'capability',
	)
	expect(capabilityMatches.length).toBeGreaterThanOrEqual(4)

	const withShapes = capabilityMatches.filter(
		(match) => match.type === 'capability' && match.inputTypeDefinition,
	)
	expect(withShapes).toHaveLength(3)
	expect(
		capabilityMatches
			.slice(0, 3)
			.every(
				(match) =>
					match.type === 'capability' &&
					typeof match.inputTypeDefinition === 'string',
			),
	).toBe(true)
	expect(capabilityMatches[3]).toMatchObject({ type: 'capability' })
	expect(capabilityMatches[3]).not.toHaveProperty('inputTypeDefinition')

	const [topMatch] = capabilityMatches
	expect(topMatch).toMatchObject({
		type: 'capability',
		name: 'openapi:widgets:createwidget',
		inputTypeDefinitionTruncated: true,
	})
	expect(topMatch?.inputTypeDefinition?.endsWith('...')).toBe(true)

	const nonTruncatedTop = await searchUnified({
		env: {} as Env,
		query: 'list widget export jobs',
		limit: 10,
		registry,
		optionalRows: emptyOptionalSearchRows,
	})
	const [listTop] = nonTruncatedTop.matches
	expect(listTop).toMatchObject({
		type: 'capability',
		name: 'openapi:widgets:listwidgets',
		inputTypeDefinition: 'type ListWidgetsInput = Record<string, never>',
	})
	expect(listTop).not.toHaveProperty('inputTypeDefinitionTruncated')
})
