import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { buildCapabilityRegistry } from '#mcp/capabilities/build-capability-registry.ts'
import {
	CAPABILITY_EMBEDDING_DIMENSIONS,
	deterministicEmbedding,
} from '#mcp/capabilities/capability-search.ts'
import { filterCapabilityRegistryForCaller } from '#mcp/capabilities/access-control.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { buildIntegrationValueName } from '#mcp/capabilities/integrations/integration-shared.ts'
import { synthesizeMcpServerToolDomain } from '#mcp/capabilities/mcp-server/index.ts'
import { synthesizeOpenApiProviderDomain } from '#mcp/capabilities/openapi-provider/index.ts'
import { synthesizeRemoteToolDomain } from '#mcp/capabilities/remote-connector/index.ts'
import { repoGetCheckStatusCapability } from '#mcp/capabilities/repo/index.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { type OpenApiBinding } from '#worker/openapi/binding-shared.ts'
import type * as PackageRegistrySource from '#worker/package-registry/source.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import {
	buildSavedPackageSearchRows,
	loadDownRemoteConnectorStatuses,
	loadOptionalSearchRows,
	searchUnified,
	settleWithBudget,
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

function leanPackage(
	id: string,
	userId: string,
	name: string,
	description: string,
): PackageSearchRow {
	return {
		record: {
			id,
			userId,
			name,
			kodyId: name,
			description,
			tags: [],
			searchText: null,
			sourceId: `source-${id}`,
			hasApp: false,
			hidden: false,
			isPrivate: false,
			createdAt: '2026-04-20T00:00:00.000Z',
			updatedAt: '2026-04-20T00:00:00.000Z',
		},
		projection: {
			name,
			kodyId: name,
			description,
			tags: [],
			searchText: null,
			hasApp: false,
			hidden: false,
			isPrivate: false,
			appEntry: null,
			exports: [],
			jobs: [],
			services: [],
			subscriptions: [],
			retrievers: [],
			webhooks: [],
		},
		readmeSnippet: null,
	}
}

function homeCapability(
	name: string,
	description: string,
	keywords: Array<string>,
) {
	return {
		name,
		domain: 'home' as const,
		description,
		keywords,
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: { type: 'object' as const, properties: {} },
		handler: async () => null,
	}
}

function leanPackageRow(
	id: string,
	userId: string,
	overrides: Partial<PackageSearchRow['record']> = {},
): PackageSearchRow {
	const row = leanPackage(
		id,
		userId,
		overrides.name ?? id,
		overrides.description ?? '',
	)
	return {
		...row,
		record: { ...row.record, ...overrides },
		projection: {
			...row.projection,
			name: overrides.name ?? row.projection.name,
			kodyId: overrides.kodyId ?? row.projection.kodyId,
			description: overrides.description ?? row.projection.description,
			tags: overrides.tags ?? row.projection.tags,
			searchText: overrides.searchText ?? row.projection.searchText,
			hasApp: overrides.hasApp ?? row.projection.hasApp,
		},
	}
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
	const packageRows = [
		leanPackageRow('pkg-1', 'user-1', {
			name: 'alpha',
			kodyId: 'beta',
			description: 'gamma',
			tags: ['delta'],
			searchText: 'epsilon',
		}),
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
		userId: 'user-1',
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
		optionalRows: emptyOptionalSearchRows,
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
		optionalRows: emptyOptionalSearchRows,
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
					isPrivate: false,
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
					isPrivate: false,
					appEntry: 'src/app.ts',
					exports: [createPackageExportProjection('.')],
					jobs: [],
					services: [],
					subscriptions: [],
					retrievers: [],
					webhooks: [],
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
			isPrivate: false,
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
			isPrivate: false,
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
			webhooks: [],
		},
	}
	const result = await searchUnified({
		env: {} as Env,
		query: 'module-a run task',
		userId: 'user-1',
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
		userId: 'user-1',
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
				isPrivate: false,
				createdAt: '2026-04-20T00:00:00.000Z',
				updatedAt: '2026-04-20T00:00:00.000Z',
			},
		],
	})

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
		userId: 'user-123',
		registry: buildCapabilityRegistry([]),
		optionalRows: {
			packageRows: rows.rows,
			userSecretRows: [],
			userValueRows: [],
		},
	})

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
				isPrivate: false,
				createdAt: '2026-03-24T00:00:00.000Z',
				updatedAt: '2026-03-24T00:00:00.000Z',
			},
		],
	})
	const degraded = await searchUnified({
		env: {} as Env,
		query: 'observed package',
		limit: 3,
		userId: 'user-123',
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
	expect(consoleWarn).toHaveBeenCalledWith(
		expect.stringContaining('package-123'),
	)
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

	const result = await searchUnified({
		env,
		query: 'summarize inbox threads',
		limit: 5,
		userId: 'user-1',
		registry: buildCapabilityRegistry([]),
		optionalRows: {
			packageRows: [
				leanPackage(
					'pkg-inbox',
					'user-1',
					'inbox-summarizer',
					'summarize inbox threads',
				),
			],
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

test('settleWithBudget uses an absolute launch deadline and degrades safely', async () => {
	await expect(
		settleWithBudget(Promise.resolve('ready'), 25),
	).resolves.toMatchObject({
		ok: true,
		value: 'ready',
		timedOut: false,
		failed: false,
	})
	await expect(
		settleWithBudget(Promise.reject(new Error('memory down')), 100),
	).resolves.toMatchObject({ ok: false, timedOut: false, failed: true })

	vi.useFakeTimers()
	try {
		const latePromise = new Promise<string>(() => {})
		const settlement = settleWithBudget(latePromise, 40)
		await vi.advanceTimersByTimeAsync(40)
		await expect(settlement).resolves.toMatchObject({
			ok: false,
			timedOut: true,
		})

		const overdue = settleWithBudget(
			new Promise(() => {}),
			1_000,
			performance.now() - 2_000,
		)
		await vi.advanceTimersByTimeAsync(0)
		await expect(overdue).resolves.toMatchObject({ ok: false, timedOut: true })
	} finally {
		vi.useRealTimers()
	}
})

test('searchUnified shares query embedding, fail-closes package isolation, and keeps lexical-only Vectorize misses', async () => {
	consoleWarn.mockImplementation(() => {})
	let aiRunCount = 0
	let inFlightQueries = 0
	let maxInFlightQueries = 0
	let packageQueryCount = 0
	const capturedFilters: Array<Record<string, unknown> | undefined> = []
	const registry = buildCapabilityRegistry([
		{
			name: 'meta',
			description: 'Meta',
			capabilities: [
				{
					name: 'inbox_summarize',
					domain: 'meta',
					description: 'summarize inbox threads',
					keywords: ['inbox', 'summarize'],
					readOnly: true,
					idempotent: true,
					destructive: false,
					inputSchema: { type: 'object', properties: {} },
					handler: async () => null,
				},
			],
		},
	])
	const env = {
		SENTRY_ENVIRONMENT: 'production',
		AI: {
			async run(...args: Array<unknown>) {
				aiRunCount += 1
				return createDeterministicAiBinding().run(...args)
			},
		},
		CAPABILITY_VECTOR_INDEX: {
			async query(
				_values: Array<number>,
				options: { filter?: Record<string, unknown> },
			) {
				capturedFilters.push(options.filter)
				inFlightQueries += 1
				maxInFlightQueries = Math.max(maxInFlightQueries, inFlightQueries)
				await new Promise((resolve) => setTimeout(resolve, 15))
				inFlightQueries -= 1
				const kind = (options.filter as { kind?: { $eq?: string } } | undefined)
					?.kind?.$eq
				if (kind === 'package') {
					packageQueryCount += 1
					return { matches: [{ id: 'package_pkg-weak', score: 0.99 }] }
				}
				return { matches: [{ id: 'inbox_summarize', score: 0.93 }] }
			},
		},
	} as unknown as Env
	const packageRows = [
		leanPackage('pkg-weak', 'user-1', 'noise-helper', 'barely related helper'),
		leanPackage(
			'pkg-lexical',
			'user-1',
			'inbox-triage',
			'summarize inbox threads for triage',
		),
	]

	const overlapped = await searchUnified({
		env,
		query: 'summarize inbox threads for triage',
		limit: 5,
		userId: 'user-1',
		registry,
		optionalRows: { packageRows, userSecretRows: [], userValueRows: [] },
	})
	expect(aiRunCount).toBe(1)
	expect(maxInFlightQueries).toBeGreaterThanOrEqual(2)
	expect(packageQueryCount).toBe(1)
	expect(capturedFilters).toContainEqual(
		expect.objectContaining({
			kind: { $eq: 'package' },
			userId: { $eq: 'user-1' },
		}),
	)
	expect(overlapped.matches[0]).toMatchObject({
		type: 'package',
		packageId: 'pkg-lexical',
	})

	packageQueryCount = 0
	const noUserOnline = await searchUnified({
		env,
		query: 'summarize inbox threads for triage',
		limit: 5,
		registry: buildCapabilityRegistry([]),
		optionalRows: {
			packageRows: [packageRows[0]!],
			userSecretRows: [],
			userValueRows: [],
		},
	})
	expect(packageQueryCount).toBe(0)
	expect(
		noUserOnline.matches.filter((match) => match.type === 'package'),
	).toEqual([])
	expect(
		(
			await searchUnified({
				env: {} as Env,
				query: 'summarize inbox threads for triage',
				limit: 5,
				registry: buildCapabilityRegistry([]),
				optionalRows: {
					packageRows: [packageRows[0]!],
					userSecretRows: [],
					userValueRows: [],
				},
			})
		).matches.filter((match) => match.type === 'package'),
	).toEqual([])

	packageQueryCount = 0
	const mismatched = await searchUnified({
		env,
		query: 'summarize inbox threads for triage',
		limit: 5,
		userId: 'user-1',
		registry: buildCapabilityRegistry([]),
		optionalRows: {
			packageRows: [
				packageRows[0]!,
				leanPackage(
					'pkg-foreign',
					'user-2',
					'foreign',
					'summarize inbox threads',
				),
			],
			userSecretRows: [],
			userValueRows: [],
		},
	})
	expect(packageQueryCount).toBe(0)
	expect(
		mismatched.matches.filter((match) => match.type === 'package'),
	).toEqual([])
})

test('searchUnified inspect affinity: live-status, package-oriented, and generic value counterexample', async () => {
	const statusCaps = [
		homeCapability(
			'sonos_list_players',
			'List known Sonos players with room names and group membership.',
			['sonos', 'speakers', 'list', 'players'],
		),
		homeCapability(
			'sonos_get_player_status',
			'Get transport, track, queue, volume, and playback status for a Sonos player.',
			['sonos', 'status', 'playing', 'speakers'],
		),
		{
			...homeCapability('sonos_play', 'Start playback on a Sonos player.', [
				'sonos',
				'play',
				'speakers',
				'start',
			]),
			readOnly: false,
			idempotent: false,
		},
		homeCapability(
			'webhook_list_status',
			'List webhook delivery status and connection state.',
			['webhook', 'status', 'list', 'connection'],
		),
	]
	const registry = buildCapabilityRegistry([
		{ name: 'home', description: 'Home', capabilities: statusCaps },
	])
	const notesPackage = leanPackageRow('pkg-sonos-notes', 'user-1', {
		name: 'sonos-setup-notes',
		description: 'Notes about configuring Sonos speakers around the home.',
		tags: ['sonos', 'notes', 'setup'],
		searchText: 'sonos speakers setup notes',
	})
	const opsPackage = leanPackageRow('pkg-home-ops', 'user-1', {
		name: 'home-ops-manager',
		description:
			'Home automation package management wrappers and workflow helpers.',
		tags: ['home', 'workflow', 'wrapper', 'package'],
		hasApp: true,
	})
	opsPackage.projection.appEntry = './app.tsx'

	const live = await searchUnified({
		env: {} as Env,
		query: 'check whether any Sonos speakers are playing',
		limit: 8,
		userId: 'user-1',
		registry,
		optionalRows: {
			packageRows: [opsPackage, notesPackage],
			userSecretRows: [],
			userValueRows: [],
		},
	})
	expect(live.intent.task.name).toBe('inspect')
	const liveNames = live.matches.map((match) =>
		match.type === 'capability'
			? match.name
			: match.type === 'package'
				? match.kodyId
				: match.type,
	)
	expect(liveNames[0]).toBe('sonos_get_player_status')
	expect(liveNames.slice(0, 3)).toContain('sonos_list_players')
	expect(liveNames.slice(0, 4)).not.toContain('home-ops-manager')
	expect(liveNames).toEqual(
		expect.arrayContaining(['sonos_get_player_status', 'sonos_play']),
	)
	expect(liveNames.indexOf('sonos_get_player_status')).toBeLessThan(
		liveNames.indexOf('sonos_play'),
	)

	const packageOriented = await searchUnified({
		env: {} as Env,
		query: 'show my Sonos setup notes',
		limit: 5,
		userId: 'user-1',
		registry,
		optionalRows: {
			packageRows: [notesPackage],
			userSecretRows: [],
			userValueRows: [],
		},
	})
	expect(packageOriented.matches[0]).toMatchObject({
		type: 'package',
		kodyId: 'sonos-setup-notes',
	})

	const genericValue = await searchUnified({
		env: {} as Env,
		query: 'show my webhook api key value',
		limit: 5,
		userId: 'user-1',
		registry,
		optionalRows: {
			packageRows: [],
			userSecretRows: [],
			userValueRows: [
				{
					name: 'webhook_api_key',
					scope: 'user',
					value: 'secret-value',
					description: 'Webhook API key value for outbound hooks',
					appId: null,
					createdAt: '2026-04-20T00:00:00.000Z',
					updatedAt: '2026-04-20T00:00:00.000Z',
					ttlMs: null,
				},
			],
		},
	})
	expect(genericValue.intent.task.name).toBe('inspect')
	expect(genericValue.matches[0]).toMatchObject({
		type: 'value',
		name: 'webhook_api_key',
	})
})

test('online search ranks remote, MCP, and OpenAPI Sonos operations above real competing builtin hits', async () => {
	const builtinCompetitorDomains = [
		{
			name: 'repo',
			description: 'Repository workspace capabilities.',
			capabilities: [repoGetCheckStatusCapability],
		},
		{
			name: 'home',
			description: 'Static builtin home automation capabilities.',
			capabilities: [
				homeCapability(
					'lutron_list_processors',
					'List discovered Lutron processors, whether credentials are stored, and the latest auth status.',
					['lutron', 'processors', 'credentials', 'status'],
				),
				homeCapability(
					'samsung_get_known_apps_status',
					'Check a curated set of common app IDs to see which apps are installed on a Samsung TV.',
					['samsung', 'apps', 'installed', 'status'],
				),
				homeCapability(
					'access_networks_unleashed_list_controllers',
					'List locally persisted Access Networks Unleashed controllers, whether one is adopted, and whether credentials are stored.',
					['access', 'networks', 'controllers', 'credentials'],
				),
			],
		},
	]
	const competingBuiltinIds = Object.keys(
		buildCapabilityRegistry(builtinCompetitorDomains).capabilitySpecs,
	)
	expect(competingBuiltinIds).toHaveLength(4)

	const targetTools = [
		{
			name: 'sonos_list_groups',
			description:
				'List Sonos groups with coordinators, member players, and current topology.',
			inputSchema: { type: 'object', properties: {} },
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		{
			name: 'sonos_list_players',
			description:
				'List known Sonos players with room names, models, group membership, and adoption state.',
			inputSchema: { type: 'object', properties: {} },
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		{
			name: 'sonos_get_group_status',
			description:
				'Get transport, playback, queue, and coordinator status for a Sonos group.',
			inputSchema: {
				type: 'object',
				properties: { groupId: { type: 'string' } },
			},
			annotations: { readOnlyHint: true },
		},
		{
			name: 'sonos_get_player_status',
			description:
				'Get transport, track, queue, volume, EQ, and input status for a Sonos player.',
			inputSchema: {
				type: 'object',
				properties: { playerId: { type: 'string' } },
			},
			annotations: { readOnlyHint: true },
		},
	]
	const providerWideDescription =
		'Local home provider for checking whether any Sonos speakers are playing.'
	const remote = await synthesizeRemoteToolDomain({
		env: {} as Env,
		userId: 'user-1',
		ref: { instanceId: 'home' },
		snapshot: {
			connectorId: 'home',
			description: providerWideDescription,
			connectedAt: '2026-07-21T00:00:00.000Z',
			lastSeenAt: '2026-07-21T00:00:01.000Z',
			tools: targetTools,
		},
	})
	const mcp = synthesizeMcpServerToolDomain({
		ref: { serverId: 'server-1', name: 'home' },
		snapshot: {
			serverId: 'server-1',
			name: 'home',
			url: 'https://mcp.example.com/mcp',
			state: 'ready',
			authUrl: null,
			error: null,
			instructions: providerWideDescription,
			tools: targetTools,
		},
	})
	const openApi = synthesizeOpenApiProviderDomain({
		binding: {
			name: 'home',
			specUrl: 'https://specs.example/openapi.json',
			apiBaseUrl: 'https://api.home.example',
			description: providerWideDescription,
			auth: { kind: 'none' },
			selection: { tags: ['home'] },
			includeDestructive: false,
			specTitle: providerWideDescription,
			specVersion: '1.0.0',
			updatedAt: '2026-07-21T00:00:00.000Z',
			operations: targetTools.map((tool) => ({
				slug: tool.name,
				operationId: tool.name,
				method: 'get',
				path: `/tools/${tool.name}`,
				summary: tool.description,
				description: null,
				tags: ['home'],
				deprecated: false,
				parameters: [],
				requestBody: null,
			})),
		} satisfies OpenApiBinding,
	})
	expect(remote).not.toBeNull()
	expect(mcp).not.toBeNull()
	expect(openApi).not.toBeNull()

	const capturedFilters: Array<unknown> = []
	let aiRunCount = 0
	const env = {
		SENTRY_ENVIRONMENT: 'production',
		AI: {
			async run(...args: Array<unknown>) {
				aiRunCount += 1
				return createDeterministicAiBinding().run(...args)
			},
		},
		CAPABILITY_VECTOR_INDEX: {
			async query(_values: Array<number>, options: { filter?: unknown }) {
				capturedFilters.push(options.filter)
				const kind = (options.filter as { kind?: { $eq?: string } } | undefined)
					?.kind?.$eq
				if (kind === 'package') return { matches: [] }
				return {
					matches: competingBuiltinIds.map((id, index) => ({
						id,
						score: 0.99 - index * 0.01,
					})),
				}
			},
		},
	} as unknown as Env
	const mixedCandidateRows = {
		packageRows: [
			leanPackageRow('pkg-sonos-diagnostics', 'user-1', {
				name: 'sonos-speaker-diagnostics',
				description:
					'Check whether any Sonos speakers are playing and report playback status.',
				tags: ['sonos', 'speakers', 'playing', 'status'],
			}),
		],
		userSecretRows: [],
		userValueRows: [
			{
				name: 'sonos_speaker_playback_status',
				scope: 'user',
				value: 'check whether any Sonos speakers are playing',
				description: 'Current Sonos speaker playback status',
				appId: null,
				createdAt: '2026-04-20T00:00:00.000Z',
				updatedAt: '2026-04-20T00:00:00.000Z',
				ttlMs: null,
			},
		],
	} satisfies Pick<
		OptionalSearchRowsResult,
		'packageRows' | 'userSecretRows' | 'userValueRows'
	>

	const cases = [
		{
			source: 'remote-connector',
			domain: remote!.domain,
			prefix: 'remote:home:',
		},
		{ source: 'mcp-server', domain: mcp!.domain, prefix: 'mcp:home:' },
		{ source: 'openapi', domain: openApi!.domain, prefix: 'openapi:home:' },
	] as const
	for (const testCase of cases) {
		const registry = buildCapabilityRegistry([
			...builtinCompetitorDomains,
			testCase.domain,
		])
		expect(
			competingBuiltinIds.every(
				(id) => registry.capabilitySpecs[id]?.source === 'builtin',
			),
		).toBe(true)
		expect(
			Object.values(registry.capabilitySpecs)
				.filter((spec) => spec.source === testCase.source)
				.map((spec) => spec.name),
		).toEqual([
			`${testCase.prefix}sonos_list_groups`,
			`${testCase.prefix}sonos_list_players`,
			`${testCase.prefix}sonos_get_group_status`,
			`${testCase.prefix}sonos_get_player_status`,
		])

		const result = await searchUnified({
			env,
			query: 'check whether any Sonos speakers are playing',
			limit: 10,
			userId: 'user-1',
			registry,
			optionalRows: mixedCandidateRows,
		})
		const capabilityNames = result.matches.flatMap((match) =>
			match.type === 'capability' ? [match.name] : [],
		)

		expect(new Set(capabilityNames.slice(0, 2))).toEqual(
			new Set([
				`${testCase.prefix}sonos_get_player_status`,
				`${testCase.prefix}sonos_list_players`,
			]),
		)
		expect(capabilityNames).toEqual(
			expect.arrayContaining([
				`${testCase.prefix}sonos_get_player_status`,
				`${testCase.prefix}sonos_list_players`,
				`${testCase.prefix}sonos_get_group_status`,
				`${testCase.prefix}sonos_list_groups`,
				'repo_get_check_status',
			]),
		)
		expect(
			capabilityNames.indexOf(`${testCase.prefix}sonos_get_player_status`),
		).toBeLessThan(capabilityNames.indexOf('repo_get_check_status'))
		expect(capabilityNames.indexOf('repo_get_check_status')).toBeGreaterThan(
			capabilityNames.indexOf(`${testCase.prefix}sonos_list_players`),
		)
		expect(
			capabilityNames.indexOf(`${testCase.prefix}sonos_get_group_status`),
		).toBeGreaterThan(
			capabilityNames.indexOf(`${testCase.prefix}sonos_get_player_status`),
		)
		expect(
			capabilityNames.indexOf(`${testCase.prefix}sonos_list_groups`),
		).toBeGreaterThan(
			capabilityNames.indexOf(`${testCase.prefix}sonos_list_players`),
		)
		expect(result.matches).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'package',
					kodyId: 'sonos-speaker-diagnostics',
				}),
				expect.objectContaining({
					type: 'value',
					name: 'sonos_speaker_playback_status',
				}),
			]),
		)

		const exactPackage = await searchUnified({
			env,
			query: 'sonos-speaker-diagnostics',
			limit: 10,
			userId: 'user-1',
			registry,
			optionalRows: {
				packageRows: mixedCandidateRows.packageRows,
				userSecretRows: [],
				userValueRows: [],
			},
		})
		const exactPackageIndex = exactPackage.matches.findIndex(
			(match) =>
				match.type === 'package' &&
				match.kodyId === 'sonos-speaker-diagnostics',
		)
		const packageProviderIndex = exactPackage.matches.findIndex(
			(match) =>
				match.type === 'capability' && match.name.startsWith(testCase.prefix),
		)
		expect(exactPackageIndex).toBe(0)
		expect(packageProviderIndex).toBeGreaterThan(exactPackageIndex)

		const exactValue = await searchUnified({
			env,
			query: 'sonos_speaker_playback_status',
			limit: 10,
			userId: 'user-1',
			registry,
			optionalRows: {
				packageRows: [],
				userSecretRows: [],
				userValueRows: mixedCandidateRows.userValueRows,
			},
		})
		const exactValueIndex = exactValue.matches.findIndex(
			(match) =>
				match.type === 'value' &&
				match.name === 'sonos_speaker_playback_status',
		)
		const valueProviderIndex = exactValue.matches.findIndex(
			(match) =>
				match.type === 'capability' && match.name.startsWith(testCase.prefix),
		)
		expect(exactValueIndex).toBe(0)
		expect(valueProviderIndex).toBeGreaterThan(exactValueIndex)
	}

	expect(capturedFilters).toHaveLength(cases.length * 5)
	expect(
		capturedFilters.filter(
			(filter) =>
				(filter as { kind?: { $eq?: string } }).kind?.$eq === 'builtin',
		),
	).toHaveLength(cases.length * 3)
	expect(
		capturedFilters.filter(
			(filter) =>
				(filter as { kind?: { $eq?: string } }).kind?.$eq === 'package',
		),
	).toHaveLength(cases.length * 2)
	expect(aiRunCount).toBe(cases.length * 3)
})

test('online search activates remote provider identity when operation names omit it', async () => {
	const remote = await synthesizeRemoteToolDomain({
		env: {} as Env,
		userId: 'user-1',
		ref: { instanceId: 'living-room' },
		snapshot: {
			connectorId: 'sonos',
			description: 'Local multi-room audio provider.',
			connectedAt: '2026-07-21T00:00:00.000Z',
			lastSeenAt: '2026-07-21T00:00:01.000Z',
			tools: [
				{
					name: 'list_players',
					description:
						'List connected players with room names and group membership.',
					inputSchema: { type: 'object', properties: {} },
					annotations: { readOnlyHint: true, idempotentHint: true },
				},
				{
					name: 'get_player_status',
					description:
						'Get transport, track, queue, volume, and playback status for a player.',
					inputSchema: {
						type: 'object',
						properties: { playerId: { type: 'string' } },
					},
					annotations: { readOnlyHint: true },
				},
			],
		},
	})
	expect(remote).not.toBeNull()
	const competitor = repoGetCheckStatusCapability
	const registry = buildCapabilityRegistry([
		{
			name: 'repo',
			description: 'Repository workspace capabilities.',
			capabilities: [competitor],
		},
		remote!.domain,
	])
	const env = {
		SENTRY_ENVIRONMENT: 'production',
		AI: createDeterministicAiBinding(),
		CAPABILITY_VECTOR_INDEX: {
			async query() {
				return {
					matches: [
						{ id: competitor.name, score: 0.99 },
						{
							id: 'remote:living-room:get_player_status',
							score: 0.5,
						},
						{ id: 'remote:living-room:list_players', score: 0.49 },
					],
				}
			},
		},
	} as unknown as Env
	const result = await searchUnified({
		env,
		query: 'check whether any Sonos speakers are playing',
		limit: 3,
		userId: 'user-1',
		registry,
		optionalRows: emptyOptionalSearchRows,
	})

	const rankedNames = result.matches.flatMap((match) =>
		match.type === 'capability' ? [match.name] : [],
	)
	expect(rankedNames).toEqual(
		expect.arrayContaining([
			'remote:living-room:get_player_status',
			'remote:living-room:list_players',
			'repo_get_check_status',
		]),
	)
	expect(
		rankedNames.indexOf('remote:living-room:get_player_status'),
	).toBeLessThan(rankedNames.indexOf('repo_get_check_status'))
	expect(rankedNames.indexOf('remote:living-room:list_players')).toBeLessThan(
		rankedNames.indexOf('repo_get_check_status'),
	)

	const synonymOnlyResult = await searchUnified({
		env,
		query: 'check whether any speakers are playing',
		limit: 3,
		userId: 'user-1',
		registry,
		optionalRows: emptyOptionalSearchRows,
	})
	const synonymOnlyRankedNames = synonymOnlyResult.matches.flatMap((match) =>
		match.type === 'capability' ? [match.name] : [],
	)
	expect(synonymOnlyRankedNames).toEqual(
		expect.arrayContaining([
			'remote:living-room:get_player_status',
			'remote:living-room:list_players',
			'repo_get_check_status',
		]),
	)
	expect(
		synonymOnlyRankedNames.indexOf('remote:living-room:get_player_status'),
	).toBeLessThan(synonymOnlyRankedNames.indexOf('repo_get_check_status'))
	expect(
		synonymOnlyRankedNames.indexOf('remote:living-room:list_players'),
	).toBeLessThan(synonymOnlyRankedNames.indexOf('repo_get_check_status'))
})

function buildDomainScopedRegistry() {
	const emailSend = defineDomainCapability('email', {
		name: 'email_send',
		description: 'Send an email message from the per-user inbox',
		keywords: ['email', 'send', 'mail'],
		readOnly: false,
		idempotent: false,
		inputSchema: {
			type: 'object',
			properties: { to: { type: 'string' } },
			required: ['to'],
		},
		handler: async () => null,
	})
	const emailList = defineDomainCapability('email', {
		name: 'email_message_list',
		description: 'List stored email messages',
		keywords: ['email', 'list', 'mail'],
		readOnly: true,
		idempotent: true,
		inputSchema: { type: 'object', properties: {} },
		handler: async () => null,
	})
	const jobSchedule = defineDomainCapability('jobs', {
		name: 'job_schedule',
		description: 'Schedule a durable job that can send email reminders',
		keywords: ['email', 'schedule', 'job'],
		readOnly: false,
		idempotent: false,
		inputSchema: { type: 'object', properties: {} },
		handler: async () => null,
	})
	return buildCapabilityRegistry([
		{
			name: 'email',
			description: 'Email primitives for the per-user inbox.',
			capabilities: [emailSend, emailList],
		},
		{
			name: 'jobs',
			description: 'Schedule durable work.',
			capabilities: [jobSchedule],
		},
	])
}

test('searchUnified domain scoping: filter, browse, reject unknown, and overview', async () => {
	const registry = buildDomainScopedRegistry()
	const scoped = await searchUnified({
		env: {} as Env,
		query: 'send email message',
		limit: 10,
		userId: 'user-1',
		registry,
		optionalRows: {
			packageRows: [
				leanPackageRow('pkg-email', 'user-1', {
					name: 'email-digest',
					kodyId: 'email-digest',
					description: 'send email message digest package',
				}),
			],
			userSecretRows: [],
			userValueRows: [],
		},
		domain: 'email',
	})

	expect(scoped.matches.length).toBeGreaterThan(0)
	for (const match of scoped.matches) {
		expect(match.type).toBe('capability')
		if (match.type === 'capability') {
			expect(match.domain).toBe('email')
		}
	}
	const names = scoped.matches.flatMap((match) =>
		match.type === 'capability' ? [match.name] : [],
	)
	expect(names).toContain('email_send')
	expect(names).not.toContain('job_schedule')

	const unknownDomain = await searchUnified({
		env: {} as Env,
		query: 'send email',
		limit: 10,
		userId: 'user-1',
		registry,
		optionalRows: emptyOptionalSearchRows,
		domain: 'nope',
	}).catch((error: unknown) => error)
	expect(unknownDomain).toBeInstanceOf(McpCallerError)
	expect(unknownDomain).toMatchObject({
		message: expect.stringMatching(/Unknown domain "nope"/),
	})

	const browse = await searchUnified({
		env: {} as Env,
		query: '',
		limit: 100,
		userId: 'user-1',
		registry,
		optionalRows: emptyOptionalSearchRows,
		domain: 'email',
	})
	expect(
		browse.matches.map((match) =>
			match.type === 'capability' ? match.name : match.type,
		),
	).toEqual(['email_send', 'email_message_list'])
	expect(browse.matches[0]).toMatchObject({
		type: 'capability',
		domain: 'email',
		inputTypeDefinition: expect.stringContaining('to'),
	})
	expect(browse.guidance).toBeDefined()

	const truncated = await searchUnified({
		env: {} as Env,
		query: '',
		limit: 1,
		userId: 'user-1',
		registry,
		optionalRows: emptyOptionalSearchRows,
		domain: 'email',
	})
	expect(truncated.matches).toHaveLength(1)
	expect(truncated.guidance).toMatch(/truncated/i)

	const overview = await searchUnified({
		env: {} as Env,
		query: 'what can you do with email',
		limit: 15,
		userId: 'user-1',
		registry,
		optionalRows: emptyOptionalSearchRows,
	})
	expect(overview.matches).toEqual([
		expect.objectContaining({
			type: 'domain',
			name: 'email',
			capabilityCount: 2,
			sampleCapabilities: ['email_send', 'email_message_list'],
		}),
	])
	expect(overview.guidance).toBeDefined()
	expect(overview.telemetry.topResultTypes).toEqual(['domain'])

	const taskQuery = await searchUnified({
		env: {} as Env,
		query: 'send an email to kent',
		limit: 15,
		userId: 'user-1',
		registry,
		optionalRows: emptyOptionalSearchRows,
	})
	expect(taskQuery.matches.every((match) => match.type === 'capability')).toBe(
		true,
	)
	expect(
		taskQuery.matches.some(
			(match) => match.type === 'capability' && match.name === 'email_send',
		),
	).toBe(true)
})
