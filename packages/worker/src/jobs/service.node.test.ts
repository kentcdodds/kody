import { expect, test, vi, afterEach } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { createCapabilitySecretAccessDeniedMessage } from '#mcp/secrets/errors.ts'
import { saveSecret } from '#mcp/secrets/service.ts'
import { saveValue } from '#mcp/values/service.ts'
import { createJob, executeJobOnce, runJobNow } from './service.ts'
import {
	type JobCreateInput,
	type JobRecord,
	type PersistedJobCallerContext,
} from './types.ts'

const repoMockModule = vi.hoisted(() => ({
	ensureEntitySource: vi.fn(),
	syncArtifactSourceSnapshot: vi.fn(),
}))

vi.mock('#worker/repo/source-service.ts', () => ({
	ensureEntitySource: (...args: Array<unknown>) =>
		repoMockModule.ensureEntitySource(...args),
}))

vi.mock('#worker/repo/source-sync.ts', () => ({
	syncArtifactSourceSnapshot: (...args: Array<unknown>) =>
		repoMockModule.syncArtifactSourceSnapshot(...args),
}))

afterEach(() => {
	vi.restoreAllMocks()
})

function mockRepoPersistence() {
	repoMockModule.ensureEntitySource.mockImplementation(
		async ({ id, userId, entityKind, entityId, sourceRoot }) => ({
			id:
				typeof id === 'string' && id.length > 0
					? id
					: `${entityKind}-${entityId}`,
			user_id: userId,
			entity_kind: entityKind,
			entity_id: entityId,
			repo_id: `${entityKind}-${entityId}`,
			published_commit: null,
			indexed_commit: null,
			manifest_path: 'package.json',
			source_root: sourceRoot ?? '/',
			created_at: '2026-04-18T00:00:00.000Z',
			updated_at: '2026-04-18T00:00:00.000Z',
			bootstrapAccess: null,
		}),
	)
	repoMockModule.syncArtifactSourceSnapshot.mockResolvedValue(
		'published-commit-1',
	)
}

function createPackageJobManifest(input: {
	packageName: string
	kodyId: string
	description: string
	jobName: string
	schedule?: Record<string, unknown>
	entry?: string
	exportPath?: string
}) {
	return {
		name: input.packageName,
		exports: {
			'.': input.exportPath ?? './src/index.ts',
		},
		kody: {
			id: input.kodyId,
			description: input.description,
			jobs: {
				[input.jobName]: {
					entry: input.entry ?? './src/job.ts',
					schedule:
						input.schedule ?? {
							type: 'once',
							runAt: '2026-04-17T15:00:00Z',
						},
				},
			},
		},
	}
}

function createPackageJobManifestText(
	input: Parameters<typeof createPackageJobManifest>[0],
) {
	return JSON.stringify(createPackageJobManifest(input))
}

vi.mock('@cloudflare/worker-bundler', () => ({
	createFileSystemSnapshot: vi.fn(
		async (files: AsyncIterable<[string, string]>) => {
			const snapshotFiles = new Map<string, string>()
			for await (const [path, content] of files) {
				snapshotFiles.set(path, content)
			}
			return {
				read(path: string) {
					return snapshotFiles.get(path) ?? null
				},
			}
		},
	),
	createWorker: vi.fn(
		async ({
			files,
			entryPoint,
		}: {
			files: Record<string, string>
			entryPoint?: string
		}) => {
			const mainModule = 'dist/bundled-entry.js'
			const selectedEntryPoint = entryPoint ?? 'index.ts'
			return {
				mainModule,
				modules: {
					[mainModule]: files[selectedEntryPoint] ?? '',
				},
				warnings: [],
			}
		},
	),
}))

vi.mock('@cloudflare/worker-bundler/typescript', () => ({
	createTypescriptLanguageService: vi.fn(async () => ({
		fileSystem: {
			read: vi.fn(() => null),
			write: vi.fn(),
		},
		languageService: {
			getSemanticDiagnostics: vi.fn((entryPoint: string) =>
				entryPoint === '.__kody_repo_module_check__.ts' ||
				entryPoint === 'src/job.ts'
					? []
					: [{ messageText: `missing ${entryPoint}` }],
			),
		},
	})),
}))

function createDatabase() {
	const tables = new Map<string, Array<Record<string, unknown>>>([
		['secret_buckets', []],
		['secret_entries', []],
		['value_buckets', []],
		['value_entries', []],
		['entity_sources', []],
		['jobs', []],
	])

	const clone = <T>(value: T): T => structuredClone(value)

	function getTable(name: string) {
		const table = tables.get(name)
		if (!table) {
			throw new Error(`Unknown table ${name}`)
		}
		return table
	}

	function selectOne(
		tableName: string,
		predicate: (row: Record<string, unknown>) => boolean,
	) {
		return clone(getTable(tableName).find(predicate) ?? null)
	}

	function selectAll(
		tableName: string,
		predicate: (row: Record<string, unknown>) => boolean = () => true,
	) {
		return clone(getTable(tableName).filter(predicate))
	}

	function upsert(
		tableName: string,
		keyPredicate: (row: Record<string, unknown>) => boolean,
		row: Record<string, unknown>,
	) {
		const table = getTable(tableName)
		const index = table.findIndex(keyPredicate)
		if (index >= 0) table[index] = clone(row)
		else table.push(clone(row))
	}

	function deleteWhere(
		tableName: string,
		predicate: (row: Record<string, unknown>) => boolean,
	) {
		const table = getTable(tableName)
		const before = table.length
		const remaining = table.filter((row) => !predicate(row))
		tables.set(tableName, remaining)
		return before - remaining.length
	}

	return {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async first<T = Record<string, unknown>>() {
							if (query.includes('FROM secret_buckets')) {
								return selectOne(
									'secret_buckets',
									(row) =>
										row['user_id'] === params[0] &&
										row['scope'] === params[1] &&
										row['binding_key'] === params[2],
								) as T | null
							}
							if (query.includes('FROM secret_entries')) {
								return selectOne(
									'secret_entries',
									(row) =>
										row['bucket_id'] === params[0] && row['name'] === params[1],
								) as T | null
							}
							if (query.includes('FROM value_buckets')) {
								return selectOne(
									'value_buckets',
									(row) =>
										row['user_id'] === params[0] &&
										row['scope'] === params[1] &&
										row['binding_key'] === params[2],
								) as T | null
							}
							if (query.includes('FROM value_entries')) {
								return selectOne(
									'value_entries',
									(row) =>
										row['bucket_id'] === params[0] && row['name'] === params[1],
								) as T | null
							}
							if (query.includes('FROM jobs WHERE id = ? AND user_id = ?')) {
								return selectOne(
									'jobs',
									(row) =>
										row['id'] === params[0] && row['user_id'] === params[1],
								) as T | null
							}
							if (query.includes('SELECT * FROM entity_sources WHERE id = ?')) {
								return selectOne(
									'entity_sources',
									(row) => row['id'] === params[0],
								) as T | null
							}
							if (query.includes('FROM jobs') && query.includes('LIMIT 1')) {
								const rows = selectAll(
									'jobs',
									(row) =>
										row['user_id'] === params[0] &&
										row['enabled'] === 1 &&
										row['kill_switch_enabled'] === 0,
								).sort((left, right) =>
									String(left['next_run_at']).localeCompare(
										String(right['next_run_at']),
									),
								)
								return (rows[0] ?? null) as T | null
							}
							throw new Error(`Unsupported first query: ${query}`)
						},
						async all<T = Record<string, unknown>>() {
							if (query.includes('FROM jobs WHERE user_id = ? ORDER BY')) {
								return {
									results: selectAll(
										'jobs',
										(row) => row['user_id'] === params[0],
									).sort((left, right) =>
										String(left['next_run_at']).localeCompare(
											String(right['next_run_at']),
										),
									) as T[],
								}
							}
							if (
								query.includes('FROM jobs') &&
								query.includes('next_run_at <= ?')
							) {
								return {
									results: selectAll(
										'jobs',
										(row) =>
											row['user_id'] === params[0] &&
											row['enabled'] === 1 &&
											row['kill_switch_enabled'] === 0 &&
											String(row['next_run_at']) <= String(params[1]),
									).sort((left, right) =>
										String(left['next_run_at']).localeCompare(
											String(right['next_run_at']),
										),
									) as T[],
								}
							}
							if (
								query.includes('FROM value_entries') &&
								query.includes('ORDER BY')
							) {
								return {
									results: selectAll(
										'value_entries',
										(row) => row['bucket_id'] === params[3],
									)
										.map((row) => ({
											scope: params[0],
											binding_key: params[1],
											name: row['name'],
											description: row['description'],
											value: row['value'],
											created_at: row['created_at'],
											updated_at: row['updated_at'],
											expires_at: params[2],
										}))
										.sort((left, right) =>
											String(left['name']).localeCompare(String(right['name'])),
										) as T[],
								}
							}
							if (
								query.includes('FROM secret_entries') &&
								query.includes('ORDER BY')
							) {
								return {
									results: selectAll(
										'secret_entries',
										(row) => row['bucket_id'] === params[4],
									)
										.map((row) => ({
											scope: params[0],
											binding_key: params[1],
											name: row['name'],
											description: row['description'],
											allowed_hosts: row['allowed_hosts'],
											allowed_capabilities: row['allowed_capabilities'],
											created_at: row['created_at'],
											updated_at: row['updated_at'],
											expires_at: params[2],
										}))
										.sort((left, right) =>
											String(left['name']).localeCompare(String(right['name'])),
										) as T[],
								}
							}
							throw new Error(`Unsupported all query: ${query}`)
						},
						async run() {
							if (query.startsWith('INSERT INTO secret_buckets')) {
								const row = {
									id: params[0],
									user_id: params[1],
									scope: params[2],
									binding_key: params[3],
									expires_at: params[4],
									created_at: params[5],
									updated_at: params[6],
								}
								upsert(
									'secret_buckets',
									(existing) =>
										existing['user_id'] === row.user_id &&
										existing['scope'] === row.scope &&
										existing['binding_key'] === row.binding_key,
									row,
								)
								return { meta: { changes: 1, last_row_id: 0 } }
							}
							if (query.startsWith('INSERT INTO secret_entries')) {
								const row = {
									bucket_id: params[0],
									name: params[1],
									description: params[2],
									encrypted_value: params[3],
									allowed_hosts: params[4],
									allowed_capabilities: params[5],
									created_at: params[6],
									updated_at: params[7],
								}
								upsert(
									'secret_entries',
									(existing) =>
										existing['bucket_id'] === row.bucket_id &&
										existing['name'] === row.name,
									row,
								)
								return { meta: { changes: 1, last_row_id: 0 } }
							}
							if (query.startsWith('INSERT INTO value_buckets')) {
								const row = {
									id: params[0],
									user_id: params[1],
									scope: params[2],
									binding_key: params[3],
									expires_at: params[4],
									created_at: params[5],
									updated_at: params[6],
								}
								upsert(
									'value_buckets',
									(existing) =>
										existing['user_id'] === row.user_id &&
										existing['scope'] === row.scope &&
										existing['binding_key'] === row.binding_key,
									row,
								)
								return { meta: { changes: 1, last_row_id: 0 } }
							}
							if (query.startsWith('INSERT INTO value_entries')) {
								const row = {
									bucket_id: params[0],
									name: params[1],
									description: params[2],
									value: params[3],
									created_at: params[4],
									updated_at: params[5],
								}
								upsert(
									'value_entries',
									(existing) =>
										existing['bucket_id'] === row.bucket_id &&
										existing['name'] === row.name,
									row,
								)
								return { meta: { changes: 1, last_row_id: 0 } }
							}
							if (query.startsWith('INSERT INTO jobs')) {
								const row = {
									id: params[0],
									user_id: params[1],
									name: params[2],
									source_id: params[3],
									published_commit: params[4],
									repo_check_policy_json: params[5],
									storage_id: params[6],
									params_json: params[7],
									schedule_json: params[8],
									timezone: params[9],
									enabled: params[10],
									kill_switch_enabled: params[11],
									caller_context_json: params[12],
									created_at: params[13],
									updated_at: params[14],
									last_run_at: params[15],
									last_run_status: params[16],
									last_run_error: params[17],
									last_duration_ms: params[18],
									next_run_at: params[19],
									run_count: params[20],
									success_count: params[21],
									error_count: params[22],
									run_history_json: params[23],
								}
								upsert(
									'jobs',
									(existing) =>
										existing['id'] === row.id &&
										existing['user_id'] === row.user_id,
									row,
								)
								return { meta: { changes: 1, last_row_id: 0 } }
							}
							if (query.startsWith('UPDATE jobs SET')) {
								const row = {
									id: params[21],
									user_id: params[22],
									name: params[0],
									source_id: params[1],
									published_commit: params[2],
									repo_check_policy_json: params[3],
									storage_id: params[4],
									params_json: params[5],
									schedule_json: params[6],
									timezone: params[7],
									enabled: params[8],
									kill_switch_enabled: params[9],
									caller_context_json: params[10],
									updated_at: params[11],
									last_run_at: params[12],
									last_run_status: params[13],
									last_run_error: params[14],
									last_duration_ms: params[15],
									next_run_at: params[16],
									run_count: params[17],
									success_count: params[18],
									error_count: params[19],
									run_history_json: params[20],
									created_at:
										selectOne(
											'jobs',
											(existing) =>
												existing['id'] === params[21] &&
												existing['user_id'] === params[22],
										)?.['created_at'] ?? params[11],
								}
								upsert(
									'jobs',
									(existing) =>
										existing['id'] === row.id &&
										existing['user_id'] === row.user_id,
									row,
								)
								return { meta: { changes: 1, last_row_id: 0 } }
							}
							if (query.startsWith('DELETE FROM jobs')) {
								return {
									meta: {
										changes: deleteWhere(
											'jobs',
											(row) =>
												row['id'] === params[0] && row['user_id'] === params[1],
										),
										last_row_id: 0,
									},
								}
							}
							throw new Error(`Unsupported run query: ${query}`)
						},
					}
				},
			}
		},
	} as unknown as D1Database
}

function createBaseCallerContext(): PersistedJobCallerContext {
	return createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-123',
			email: 'user@example.com',
			displayName: 'User Example',
		},
		storageContext: {
			sessionId: null,
			appId: 'app-123',
		},
	}) as PersistedJobCallerContext
}

test('createJob stores a codemode job with interval support', async () => {
	const env = {
		APP_DB: createDatabase(),
	} as Env
	mockRepoPersistence()
	const callerContext = createBaseCallerContext()

	const result = await createJob({
		env,
		callerContext,
		body: {
			name: 'Deploy Worker',
			code: 'export default async () => ({ ok: true })',
			schedule: {
				type: 'interval',
				every: '15m',
			},
		} satisfies JobCreateInput,
	})

	expect(result.schedule).toEqual({
		type: 'interval',
		every: '15m',
	})
	expect(result.scheduleSummary).toBe('Runs every 15m')
})

test('createJob assigns a stable job storage id', async () => {
	const env = {
		APP_DB: createDatabase(),
	} as Env
	mockRepoPersistence()
	const callerContext = createBaseCallerContext()

	const created = await createJob({
		env,
		callerContext,
		body: {
			name: 'Storage-backed job',
			code: 'export default async () => ({ ok: true })',
			schedule: {
				type: 'interval',
				every: '15m',
			},
		},
	})

	expect(created.storageId).toBe(`job:${created.id}`)
})

test('executeJobOnce binds scheduled jobs to writable storage', async () => {
	const db = createDatabase()
	const env = {
		APP_DB: db,
		LOADER: {} as WorkerLoader,
		REPO_SESSION: {} as DurableObjectNamespace,
		STORAGE_RUNNER: {
			idFromName(name: string) {
				return name as unknown as DurableObjectId
			},
			get() {
				return {
					getValue: async () => ({ key: 'count', value: 2 }),
					setValue: async () => ({ ok: true, key: 'count' }),
					deleteValue: async () => ({ ok: true, key: 'count', deleted: true }),
					clearStorage: async () => ({ ok: true }),
					listValues: async () => ({
						entries: [],
						estimatedBytes: 0,
						truncated: false,
						nextStartAfter: null,
						pageSize: 250,
					}),
					exportStorage: async () => ({
						entries: [],
						estimatedBytes: 0,
						truncated: false,
						nextStartAfter: null,
						pageSize: 250,
					}),
					sqlQuery: async () => ({
						columns: ['value'],
						rows: [{ value: 2 }],
						rowCount: 1,
						rowsRead: 1,
						rowsWritten: 0,
					}),
				}
			},
		},
	} as unknown as Env
	mockRepoPersistence()
	const callerContext = createBaseCallerContext()

	const jobView = await createJob({
		env,
		callerContext,
		body: {
			name: 'Storage bridge',
			code: 'export default async (params) => { await storage.set("count", params.stepCount); return await storage.sql("select 2 as value") }',
			params: {
				stepCount: 2,
			},
			schedule: {
				type: 'once',
				runAt: '2026-04-17T15:00:00Z',
			},
		},
	})

	const executeSpy = vi
		.spyOn(
			await import('#mcp/run-codemode-registry.ts'),
			'runBundledModuleWithRegistry',
		)
		.mockResolvedValue({
			result: {
				value: 2,
			},
			logs: ['storage helper executed'],
		})

	try {
		const sessionClient = {
			openSession: vi.fn(async () => ({
				id: `job-runtime-${jobView.id}`,
				source_id: jobView.sourceId,
				source_root: '/',
				base_commit: 'published-commit-1',
				session_repo_id: 'session-repo-storage',
				session_repo_name: 'session-repo-name',
				session_repo_namespace: 'default',
				conversation_id: null,
				last_checkpoint_commit: null,
				last_check_run_id: null,
				last_check_tree_hash: null,
				expires_at: null,
				created_at: '2026-04-16T00:00:00.000Z',
				updated_at: '2026-04-16T00:00:00.000Z',
				published_commit: 'published-commit-1',
				manifest_path: 'package.json',
				entity_type: 'job' as const,
			})),
			runChecks: vi.fn(async () => ({
				ok: true,
				results: [],
				manifest: createPackageJobManifest({
					packageName: '@kody/storage-bridge',
					kodyId: 'storage-bridge',
					description: 'Runs from repo',
					jobName: 'Storage bridge',
				}),
			})),
			readFile: vi.fn(async ({ path }: { path: string }) => ({
				path,
				content:
					path === 'package.json'
						? createPackageJobManifestText({
								packageName: '@kody/storage-bridge',
								kodyId: 'storage-bridge',
								description: 'Runs from repo',
								jobName: 'Storage bridge',
							})
						: 'export default async (params) => { await storage.set("count", params.stepCount); return await storage.sql("select 2 as value") }',
			})),
			tree: vi.fn(async () => ({
				path: '',
				name: '',
				type: 'directory' as const,
				size: 0,
				children: [
					{
						path: 'src/job.ts',
						name: 'job.ts',
						type: 'file' as const,
						size: 1,
					},
				],
			})),
			discardSession: vi.fn(),
		}
		const repoSessionRpcSpy = vi
			.spyOn(await import('#worker/repo/repo-session-do.ts'), 'repoSessionRpc')
			.mockReturnValue(sessionClient as never)
		const row = await (
			await import('./repo.ts')
		).getJobRowById(db, callerContext.user.userId, jobView.id)
		if (!row) {
			throw new Error('Expected created job row.')
		}
		expect(row.record.storageId).toBe(`job:${jobView.id}`)
		const outcome = await executeJobOnce({
			env,
			job: row.record,
			callerContext,
		})

		expect(outcome.execution).toEqual({
			ok: true,
			result: {
				value: 2,
			},
			logs: ['storage helper executed'],
		})
		repoSessionRpcSpy.mockRestore()
	} finally {
		executeSpy.mockRestore()
	}
})

test('executeJobOnce preserves codemode secret and value semantics', async () => {
	const db = createDatabase()
	const env = {
		APP_DB: db,
		COOKIE_SECRET: 'test-secret-0123456789abcdef0123456789',
		LOADER: {} as WorkerLoader,
		REPO_SESSION: {} as DurableObjectNamespace,
	} as unknown as Env
	mockRepoPersistence()
	const callerContext = createBaseCallerContext()

	await saveSecret({
		env,
		userId: callerContext.user.userId,
		scope: 'app',
		name: 'apiToken',
		value: 'very-secret-token',
		storageContext: callerContext.storageContext,
	})
	await saveValue({
		env,
		userId: callerContext.user.userId,
		scope: 'app',
		name: 'projectId',
		value: 'alpha-project',
		storageContext: callerContext.storageContext,
	})

	const jobView = await createJob({
		env,
		callerContext,
		body: {
			name: 'Use codemode semantics',
			code: 'export default async () => ({ ok: true })',
			params: {
				step: 'deploy',
			},
			schedule: {
				type: 'once',
				runAt: '2026-04-17T15:00:00Z',
			},
		},
	})

	const executeSpy = vi
		.spyOn(
			await import('#mcp/run-codemode-registry.ts'),
			'runBundledModuleWithRegistry',
		)
		.mockResolvedValue({
			result: {
				secretValue: 'very-secret-token',
				value: 'alpha-project',
				userId: 'user-123',
				storageId: `job:${jobView.id}`,
			},
			logs: ['codemode executed'],
		})

	try {
		const sessionClient = {
			openSession: vi.fn(async () => ({
				id: `job-runtime-${jobView.id}`,
				source_id: jobView.sourceId,
				source_root: '/',
				base_commit: 'published-commit-1',
				session_repo_id: 'session-repo-secret',
				session_repo_name: 'session-repo-name',
				session_repo_namespace: 'default',
				conversation_id: null,
				last_checkpoint_commit: null,
				last_check_run_id: null,
				last_check_tree_hash: null,
				expires_at: null,
				created_at: '2026-04-16T00:00:00.000Z',
				updated_at: '2026-04-16T00:00:00.000Z',
				published_commit: 'published-commit-1',
				manifest_path: 'package.json',
				entity_type: 'job' as const,
			})),
			runChecks: vi.fn(async () => ({
				ok: true,
				results: [],
				manifest: createPackageJobManifest({
					packageName: '@kody/codemode-semantics',
					kodyId: 'codemode-semantics',
					description: 'Runs from repo',
					jobName: 'Use codemode semantics',
				}),
			})),
			readFile: vi.fn(async ({ path }: { path: string }) => ({
				path,
				content:
					path === 'package.json'
						? createPackageJobManifestText({
								packageName: '@kody/codemode-semantics',
								kodyId: 'codemode-semantics',
								description: 'Runs from repo',
								jobName: 'Use codemode semantics',
							})
						: 'export default async () => ({ ok: true })',
			})),
			tree: vi.fn(async () => ({
				path: '',
				name: '',
				type: 'directory' as const,
				size: 0,
				children: [
					{
						path: 'src/job.ts',
						name: 'job.ts',
						type: 'file' as const,
						size: 1,
					},
				],
			})),
			discardSession: vi.fn(),
		}
		const repoSessionRpcSpy = vi
			.spyOn(await import('#worker/repo/repo-session-do.ts'), 'repoSessionRpc')
			.mockReturnValue(sessionClient as never)
		const row = await (
			await import('./repo.ts')
		).getJobRowById(db, callerContext.user.userId, jobView.id)
		if (!row) {
			throw new Error('Expected created job row.')
		}
		const outcome = await executeJobOnce({
			env,
			job: row.record,
			callerContext,
		})

		const [spyEnv, spyCallerContext] = executeSpy.mock.calls[0] ?? []
		expect(spyEnv).toBe(env)
		expect(spyCallerContext).toMatchObject({
			baseUrl: 'https://example.com',
			repoContext: expect.objectContaining({
				entityKind: 'job',
				publishedCommit: 'published-commit-1',
			}),
		})
		expect(spyCallerContext).toHaveProperty('storageContext.sessionId', null)
		expect(spyCallerContext).toHaveProperty('storageContext.appId', 'app-123')
		expect(spyCallerContext).toHaveProperty(
			'storageContext.storageId',
			`job:${jobView.id}`,
		)

		expect(outcome.execution).toEqual({
			ok: true,
			result: {
				secretValue: 'very-secret-token',
				value: 'alpha-project',
				userId: 'user-123',
				storageId: `job:${jobView.id}`,
			},
			logs: ['codemode executed'],
		})
		expect(executeSpy.mock.calls[0]?.[2]).toMatchObject({
			mainModule: 'dist/bundled-entry.js',
		})
		expect(
			String(
				executeSpy.mock.calls[0]?.[2]?.modules?.['dist/bundled-entry.js'] ?? '',
			),
		).toContain('return await entrypoint({"step":"deploy"});')
		repoSessionRpcSpy.mockRestore()
	} finally {
		executeSpy.mockRestore()
	}
})

test('executeJobOnce refreshes repo sessions when base commit moves', async () => {
	const env = {
		APP_DB: createDatabase(),
		LOADER: {} as WorkerLoader,
	} as Env
	const callerContext = createBaseCallerContext()
	const job: JobRecord = {
		version: 1,
		id: 'job-repo-1',
		userId: callerContext.user.userId,
		name: 'Repo-backed job',
		sourceId: 'source-1',
		publishedCommit: 'commit-1',
		storageId: 'job:job-repo-1',
		schedule: {
			type: 'once',
			runAt: '2026-04-17T15:00:00Z',
		},
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		createdAt: '2026-04-16T00:00:00.000Z',
		updatedAt: '2026-04-16T00:00:00.000Z',
		nextRunAt: '2026-04-17T15:00:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
		runHistory: [],
	}
	const sessionClient = {
		openSession: vi
			.fn()
			.mockResolvedValueOnce({
				id: 'job-runtime-job-repo-1',
				source_id: 'source-1',
				source_root: '/',
				base_commit: 'base-1',
				session_repo_id: 'session-repo-1',
				session_repo_name: 'session-repo-name',
				session_repo_namespace: 'default',
				conversation_id: null,
				last_checkpoint_commit: null,
				last_check_run_id: null,
				last_check_tree_hash: null,
				expires_at: null,
				created_at: '2026-04-16T00:00:00.000Z',
				updated_at: '2026-04-16T00:00:00.000Z',
				published_commit: 'commit-1',
				manifest_path: 'package.json',
				entity_type: 'job',
			})
			.mockResolvedValueOnce({
				id: 'job-runtime-job-repo-1',
				source_id: 'source-1',
				source_root: '/',
				base_commit: 'commit-1',
				session_repo_id: 'session-repo-1',
				session_repo_name: 'session-repo-name',
				session_repo_namespace: 'default',
				conversation_id: null,
				last_checkpoint_commit: null,
				last_check_run_id: null,
				last_check_tree_hash: null,
				expires_at: null,
				created_at: '2026-04-16T00:00:00.000Z',
				updated_at: '2026-04-16T00:00:00.000Z',
				published_commit: 'commit-1',
				manifest_path: 'package.json',
				entity_type: 'job',
			}),
		runChecks: vi.fn(async () => ({
			ok: true,
			results: [],
			manifest: createPackageJobManifest({
				packageName: '@kody/repo-backed-job',
				kodyId: 'repo-backed-job',
				description: 'Runs from repo',
				jobName: 'Repo-backed job',
				entry: './src/job.ts',
			}),
		})),
		readFile: vi.fn(async ({ path }: { path: string }) => ({
			path,
			content:
				path === 'package.json'
					? createPackageJobManifestText({
							packageName: '@kody/repo-backed-job',
							kodyId: 'repo-backed-job',
							description: 'Runs from repo',
							jobName: 'Repo-backed job',
							entry: './src/job.ts',
						})
					: 'export default async () => ({ ok: true, repoBacked: true })',
		})),
		tree: vi.fn(async () => ({
			path: '',
			name: '',
			type: 'directory' as const,
			size: 0,
			children: [
				{
					path: 'src/job.ts',
					name: 'job.ts',
					type: 'file' as const,
					size: 1,
				},
			],
		})),
		discardSession: vi.fn(async () => ({
			ok: true as const,
			sessionId: 'job-runtime-job-repo-1',
			deleted: true,
		})),
	}

	const repoSessionRpcSpy = vi
		.spyOn(await import('#worker/repo/repo-session-do.ts'), 'repoSessionRpc')
		.mockReturnValue(sessionClient as never)
	const executeSpy = vi
		.spyOn(
			await import('#mcp/run-codemode-registry.ts'),
			'runBundledModuleWithRegistry',
		)
		.mockResolvedValue({
			result: { ok: true, repoBacked: true },
			logs: ['repo-backed codemode executed'],
		})

	try {
		const outcome = await executeJobOnce({
			env,
			job,
			callerContext,
		})

		expect(outcome.execution).toEqual({
			ok: true,
			result: { ok: true, repoBacked: true },
			logs: ['repo-backed codemode executed'],
		})
		expect(sessionClient.openSession).toHaveBeenCalledTimes(2)
		const firstOpenSessionId = sessionClient.openSession.mock.calls[0]?.[0]?.sessionId
		const secondOpenSessionId =
			sessionClient.openSession.mock.calls[1]?.[0]?.sessionId
		expect(firstOpenSessionId).toMatch(/^job-runtime-job-repo-1-/)
		expect(secondOpenSessionId).toBe(firstOpenSessionId)
		expect(sessionClient.discardSession).toHaveBeenCalledWith({
			sessionId: 'job-runtime-job-repo-1',
			userId: 'user-123',
		})
		expect(sessionClient.discardSession).toHaveBeenCalledWith({
			sessionId: firstOpenSessionId,
			userId: 'user-123',
		})
		expect(sessionClient.readFile).toHaveBeenCalledWith({
			sessionId: 'job-runtime-job-repo-1',
			userId: 'user-123',
			path: 'src/job.ts',
		})
		expect(executeSpy).toHaveBeenCalledTimes(1)
	} finally {
		repoSessionRpcSpy.mockRestore()
		executeSpy.mockRestore()
	}
})

test('executeJobOnce blocks repo-backed jobs on typecheck failures by default', async () => {
	const env = {
		APP_DB: createDatabase(),
		LOADER: {} as WorkerLoader,
	} as Env
	const callerContext = createBaseCallerContext()
	const job: JobRecord = {
		version: 1,
		id: 'job-repo-typecheck-strict',
		userId: callerContext.user.userId,
		name: 'Repo-backed strict typecheck job',
		sourceId: 'source-strict',
		publishedCommit: 'commit-strict',
		storageId: 'job:job-repo-typecheck-strict',
		schedule: {
			type: 'once',
			runAt: '2026-04-17T15:00:00Z',
		},
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		createdAt: '2026-04-16T00:00:00.000Z',
		updatedAt: '2026-04-16T00:00:00.000Z',
		nextRunAt: '2026-04-17T15:00:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
		runHistory: [],
	}
	const sessionClient = {
		openSession: vi.fn(async () => ({
			id: 'job-runtime-job-repo-typecheck-strict',
			source_id: 'source-strict',
			source_root: '/',
			base_commit: 'commit-strict',
			session_repo_id: 'session-repo-strict',
			session_repo_name: 'session-repo-name',
			session_repo_namespace: 'default',
			conversation_id: null,
			last_checkpoint_commit: null,
			last_check_run_id: null,
			last_check_tree_hash: null,
			expires_at: null,
			created_at: '2026-04-16T00:00:00.000Z',
			updated_at: '2026-04-16T00:00:00.000Z',
			published_commit: 'commit-strict',
				manifest_path: 'package.json',
			entity_type: 'job' as const,
		})),
		runChecks: vi.fn(async () => ({
			ok: false,
			results: [
				{
					kind: 'typecheck' as const,
					ok: false,
					message: "src/job.ts:1:28 Cannot find name 'codemode'.",
				},
			],
			manifest: createPackageJobManifest({
				packageName: '@kody/repo-typecheck-strict',
				kodyId: 'repo-typecheck-strict',
				description: 'Runs from repo',
				jobName: 'Repo-backed strict typecheck job',
			}),
			runId: 'check-run-strict',
			treeHash: 'tree-hash-strict',
			checkedAt: '2026-04-16T00:00:00.000Z',
		})),
		readFile: vi.fn(),
		discardSession: vi.fn(),
	}

	const repoSessionRpcSpy = vi
		.spyOn(await import('#worker/repo/repo-session-do.ts'), 'repoSessionRpc')
		.mockReturnValue(sessionClient as never)
	const executeSpy = vi.spyOn(
		await import('#mcp/run-codemode-registry.ts'),
		'runBundledModuleWithRegistry',
	)

	try {
		const outcome = await executeJobOnce({
			env,
			job,
			callerContext,
		})

		expect(outcome.execution).toEqual({
			ok: false,
			error: "src/job.ts:1:28 Cannot find name 'codemode'.",
			logs: [],
		})
		expect(sessionClient.readFile).not.toHaveBeenCalled()
		expect(executeSpy).not.toHaveBeenCalled()
	} finally {
		repoSessionRpcSpy.mockRestore()
		executeSpy.mockRestore()
	}
})

test('executeJobOnce bypasses typecheck-only failures when the stored repo policy allows it', async () => {
	const env = {
		APP_DB: createDatabase(),
		LOADER: {} as WorkerLoader,
	} as Env
	const callerContext = createBaseCallerContext()
	const job: JobRecord = {
		version: 1,
		id: 'job-repo-typecheck-bypass',
		userId: callerContext.user.userId,
		name: 'Repo-backed bypass typecheck job',
		sourceId: 'source-bypass',
		publishedCommit: 'commit-bypass',
		repoCheckPolicy: {
			allowTypecheckFailures: true,
		},
		storageId: 'job:job-repo-typecheck-bypass',
		schedule: {
			type: 'once',
			runAt: '2026-04-17T15:00:00Z',
		},
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		createdAt: '2026-04-16T00:00:00.000Z',
		updatedAt: '2026-04-16T00:00:00.000Z',
		nextRunAt: '2026-04-17T15:00:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
		runHistory: [],
	}
	const sessionClient = {
		openSession: vi.fn(async () => ({
			id: 'job-runtime-job-repo-typecheck-bypass',
			source_id: 'source-bypass',
			source_root: '/',
			base_commit: 'commit-bypass',
			session_repo_id: 'session-repo-bypass',
			session_repo_name: 'session-repo-name',
			session_repo_namespace: 'default',
			conversation_id: null,
			last_checkpoint_commit: null,
			last_check_run_id: null,
			last_check_tree_hash: null,
			expires_at: null,
			created_at: '2026-04-16T00:00:00.000Z',
			updated_at: '2026-04-16T00:00:00.000Z',
			published_commit: 'commit-bypass',
				manifest_path: 'package.json',
			entity_type: 'job' as const,
		})),
		runChecks: vi.fn(async () => ({
			ok: false,
			results: [
				{
					kind: 'typecheck' as const,
					ok: false,
					message: "src/job.ts:1:28 Cannot find name 'codemode'.",
				},
			],
			manifest: createPackageJobManifest({
				packageName: '@kody/repo-typecheck-bypass',
				kodyId: 'repo-typecheck-bypass',
				description: 'Runs from repo',
				jobName: 'Repo-backed bypass typecheck job',
			}),
			runId: 'check-run-bypass',
			treeHash: 'tree-hash-bypass',
			checkedAt: '2026-04-16T00:00:00.000Z',
		})),
		readFile: vi.fn(async ({ path }: { path: string }) => ({
			path,
			content:
				path === 'package.json'
					? createPackageJobManifestText({
							packageName: '@kody/repo-typecheck-bypass',
							kodyId: 'repo-typecheck-bypass',
							description: 'Runs from repo',
							jobName: 'Repo-backed bypass typecheck job',
						})
					: 'export default async () => ({ ok: true, bypassed: true })',
		})),
		tree: vi.fn(async () => ({
			path: '',
			name: '',
			type: 'directory' as const,
			size: 0,
			children: [
				{
					path: 'src/job.ts',
					name: 'job.ts',
					type: 'file' as const,
					size: 1,
				},
			],
		})),
		discardSession: vi.fn(),
	}

	const repoSessionRpcSpy = vi
		.spyOn(await import('#worker/repo/repo-session-do.ts'), 'repoSessionRpc')
		.mockReturnValue(sessionClient as never)
	const executeSpy = vi
		.spyOn(
			await import('#mcp/run-codemode-registry.ts'),
			'runBundledModuleWithRegistry',
		)
		.mockResolvedValue({
			result: { ok: true, bypassed: true },
			logs: ['repo-backed codemode executed'],
		})

	try {
		const outcome = await executeJobOnce({
			env,
			job,
			callerContext,
		})

		expect(outcome.execution).toEqual({
			ok: true,
			result: { ok: true, bypassed: true },
			logs: [
				'Bypassed repo typecheck-only check failures for job "job-repo-typecheck-bypass" (source "source-bypass", check run check-run-bypass).',
				'repo-backed codemode executed',
			],
		})
		expect(sessionClient.readFile).toHaveBeenCalledWith({
			sessionId: 'job-runtime-job-repo-typecheck-bypass',
			userId: 'user-123',
			path: 'src/job.ts',
		})
		expect(executeSpy).toHaveBeenCalledTimes(1)
	} finally {
		repoSessionRpcSpy.mockRestore()
		executeSpy.mockRestore()
	}
})

test('executeJobOnce preserves bypass audit logs when execution fails after a typecheck-only bypass', async () => {
	const env = {
		APP_DB: createDatabase(),
		LOADER: {} as WorkerLoader,
	} as Env
	const callerContext = createBaseCallerContext()
	const job: JobRecord = {
		version: 1,
		id: 'job-repo-typecheck-bypass-failure',
		userId: callerContext.user.userId,
		name: 'Repo-backed bypass failure job',
		code: null,
		sourceId: 'source-bypass-failure',
		publishedCommit: 'commit-bypass-failure',
		repoCheckPolicy: {
			allowTypecheckFailures: true,
		},
		storageId: 'job:job-repo-typecheck-bypass-failure',
		schedule: {
			type: 'once',
			runAt: '2026-04-17T15:00:00Z',
		},
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		createdAt: '2026-04-16T00:00:00.000Z',
		updatedAt: '2026-04-16T00:00:00.000Z',
		nextRunAt: '2026-04-17T15:00:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
		runHistory: [],
	}
	const sessionClient = {
		openSession: vi.fn(async () => ({
			id: 'job-runtime-job-repo-typecheck-bypass-failure',
			source_id: 'source-bypass-failure',
			source_root: '/',
			base_commit: 'commit-bypass-failure',
			session_repo_id: 'session-repo-bypass-failure',
			session_repo_name: 'session-repo-name',
			session_repo_namespace: 'default',
			conversation_id: null,
			last_checkpoint_commit: null,
			last_check_run_id: null,
			last_check_tree_hash: null,
			expires_at: null,
			created_at: '2026-04-16T00:00:00.000Z',
			updated_at: '2026-04-16T00:00:00.000Z',
			published_commit: 'commit-bypass-failure',
				manifest_path: 'package.json',
			entity_type: 'job' as const,
		})),
		runChecks: vi.fn(async () => ({
			ok: false,
			results: [
				{
					kind: 'typecheck' as const,
					ok: false,
					message: "src/job.ts:1:28 Cannot find name 'codemode'.",
				},
			],
			manifest: createPackageJobManifest({
				packageName: '@kody/repo-bypass-failure',
				kodyId: 'repo-bypass-failure',
				description: 'Runs from repo',
				jobName: 'Repo-backed bypass failure job',
			}),
			runId: 'check-run-bypass-failure',
			treeHash: 'tree-hash-bypass-failure',
			checkedAt: '2026-04-16T00:00:00.000Z',
		})),
		readFile: vi.fn(async ({ path }: { path: string }) => ({
			path,
			content:
				path === 'package.json'
					? createPackageJobManifestText({
							packageName: '@kody/repo-bypass-failure',
							kodyId: 'repo-bypass-failure',
							description: 'Runs from repo',
							jobName: 'Repo-backed bypass failure job',
						})
					: 'export default async () => ({ ok: true, bypassed: true })',
		})),
		tree: vi.fn(async () => ({
			path: '',
			name: '',
			type: 'directory' as const,
			size: 0,
			children: [
				{
					path: 'src/job.ts',
					name: 'job.ts',
					type: 'file' as const,
					size: 1,
				},
			],
		})),
		discardSession: vi.fn(),
	}

	const repoSessionRpcSpy = vi
		.spyOn(await import('#worker/repo/repo-session-do.ts'), 'repoSessionRpc')
		.mockReturnValue(sessionClient as never)
	const executeSpy = vi.spyOn(
		await import('#mcp/run-codemode-registry.ts'),
		'runBundledModuleWithRegistry',
	)
	const formatJobErrorSpy = vi.spyOn(
		await import('./schedule.ts'),
		'formatJobError',
	)

	try {
		executeSpy.mockRejectedValueOnce(new Error('Executor import failed'))

		const outcome = await executeJobOnce({
			env,
			job,
			callerContext,
		})

		expect(outcome.execution).toEqual({
			ok: false,
			error: 'Executor import failed',
			logs: [
				'Bypassed repo typecheck-only check failures for job "job-repo-typecheck-bypass-failure" (source "source-bypass-failure", check run check-run-bypass-failure).',
			],
		})
		expect(formatJobErrorSpy).toHaveBeenCalled()
	} finally {
		repoSessionRpcSpy.mockRestore()
		executeSpy.mockRestore()
		formatJobErrorSpy.mockRestore()
	}
})

test('executeJobOnce succeeds for repo-backed jobs with repo-session absolute paths and migrated entrypoints', async () => {
	const env = {
		APP_DB: createDatabase(),
		LOADER: {} as WorkerLoader,
	} as Env
	const callerContext = createBaseCallerContext()
	const job: JobRecord = {
		version: 1,
		id: 'job-repo-absolute-paths',
		userId: callerContext.user.userId,
		name: 'Repo-backed absolute path job',
		code: null,
		sourceId: 'source-absolute-paths',
		publishedCommit: 'commit-absolute',
		storageId: 'job:job-repo-absolute-paths',
		schedule: {
			type: 'once',
			runAt: '2026-04-17T15:00:00Z',
		},
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		createdAt: '2026-04-16T00:00:00.000Z',
		updatedAt: '2026-04-16T00:00:00.000Z',
		nextRunAt: '2026-04-17T15:00:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
		runHistory: [],
	}

	const sessionClient = {
		openSession: vi.fn(async () => ({
			id: 'job-runtime-job-repo-absolute-paths',
			source_id: 'source-absolute-paths',
			source_root: '/',
			base_commit: 'commit-absolute',
			session_repo_id: 'session-repo-absolute',
			session_repo_name: 'session-repo-name',
			session_repo_namespace: 'default',
			conversation_id: null,
			last_checkpoint_commit: null,
			last_check_run_id: null,
			last_check_tree_hash: null,
			expires_at: null,
			created_at: '2026-04-16T00:00:00.000Z',
			updated_at: '2026-04-16T00:00:00.000Z',
			published_commit: 'commit-absolute',
			manifest_path: 'package.json',
			entity_type: 'job' as const,
		})),
		runChecks: vi.fn(async () => {
			const { runRepoChecks } = await import('#worker/repo/checks.ts')
			return runRepoChecks({
				workspace: {
					async readFile(path: string) {
						const file = workspaceFiles.get(path)
						return file ?? workspaceFiles.get(path.replace(/^\/+/, '')) ?? null
					},
					async glob() {
						return Array.from(workspaceFiles.keys()).map((path) => ({
							path,
							type: 'file',
						}))
					},
				},
				manifestPath: '/session/package.json',
				sourceRoot: '/session/',
			})
		}),
		readFile: vi.fn(async ({ path }: { path: string }) => ({
			path,
			content:
				path === 'package.json'
					? createPackageJobManifestText({
							packageName: '@kody/repo-absolute-path-job',
							kodyId: 'repo-absolute-path-job',
							description: 'Runs from repo session files',
							jobName: 'Repo-backed absolute path job',
							exportPath: './src/job.ts',
						})
					: 'export default async () => ({ ok: true, normalized: true })',
		})),
		tree: vi.fn(async () => ({
			path: '',
			name: '',
			type: 'directory' as const,
			size: 0,
			children: [
				{
					path: 'src/job.ts',
					name: 'job.ts',
					type: 'file' as const,
					size: 1,
				},
				{
					path: 'package.json',
					name: 'package.json',
					type: 'file' as const,
					size: 1,
				},
			],
		})),
		discardSession: vi.fn(async () => ({
			ok: true as const,
			sessionId: 'job-runtime-job-repo-absolute-paths',
			deleted: true,
		})),
	}
	const workspaceFiles = new Map<string, string>([
		[
			'/session/package.json',
			createPackageJobManifestText({
				packageName: '@kody/repo-absolute-path-job',
				kodyId: 'repo-absolute-path-job',
				description: 'Runs from repo session files',
				jobName: 'Repo-backed absolute path job',
				exportPath: './src/job.ts',
			}),
		],
		['/session/src/job.ts', 'export default async () => ({ ok: true })\n'],
	])

	const repoSessionRpcSpy = vi
		.spyOn(await import('#worker/repo/repo-session-do.ts'), 'repoSessionRpc')
		.mockReturnValue(sessionClient as never)
	const executeSpy = vi
		.spyOn(
			await import('#mcp/run-codemode-registry.ts'),
			'runBundledModuleWithRegistry',
		)
		.mockResolvedValue({
			result: { ok: true, normalized: true },
			logs: ['repo-backed codemode executed'],
		})

	try {
		const outcome = await executeJobOnce({
			env,
			job,
			callerContext,
		})

		expect(outcome.execution).toEqual({
			ok: true,
			result: { ok: true, normalized: true },
			logs: ['repo-backed codemode executed'],
		})
		expect(sessionClient.runChecks).toHaveBeenCalledTimes(1)
		expect(sessionClient.readFile).toHaveBeenCalledWith({
			sessionId: 'job-runtime-job-repo-absolute-paths',
			userId: 'user-123',
			path: 'src/job.ts',
		})
		expect(executeSpy).toHaveBeenCalledTimes(1)
	} finally {
		repoSessionRpcSpy.mockRestore()
		executeSpy.mockRestore()
	}
})

test('executeJobOnce fails instead of reusing a stale repo session when discard fails', async () => {
	const env = {
		APP_DB: createDatabase(),
		LOADER: {} as WorkerLoader,
	} as Env
	const callerContext = createBaseCallerContext()
	const job: JobRecord = {
		version: 1,
		id: 'job-repo-discard-failure',
		userId: callerContext.user.userId,
		name: 'Repo-backed job discard failure',
		code: null,
		sourceId: 'source-1',
		publishedCommit: 'commit-1',
		storageId: 'job:job-repo-discard-failure',
		schedule: {
			type: 'once',
			runAt: '2026-04-17T15:00:00Z',
		},
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		createdAt: '2026-04-16T00:00:00.000Z',
		updatedAt: '2026-04-16T00:00:00.000Z',
		nextRunAt: '2026-04-17T15:00:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
		runHistory: [],
	}

	const discardFailure = new Error('D1 delete failed')
	const sessionClient = {
		openSession: vi.fn(async () => ({
			id: 'job-runtime-job-repo-discard-failure',
			source_id: 'source-1',
			source_root: '/',
			base_commit: 'base-1',
			session_repo_id: 'session-repo-1',
			session_repo_name: 'session-repo-name',
			session_repo_namespace: 'default',
			conversation_id: null,
			last_checkpoint_commit: null,
			last_check_run_id: null,
			last_check_tree_hash: null,
			expires_at: null,
			created_at: '2026-04-16T00:00:00.000Z',
			updated_at: '2026-04-16T00:00:00.000Z',
			published_commit: 'commit-1',
				manifest_path: 'package.json',
			entity_type: 'job' as const,
		})),
		runChecks: vi.fn(),
		readFile: vi.fn(),
		discardSession: vi.fn(async () => {
			throw discardFailure
		}),
	}

	const repoSessionRpcSpy = vi
		.spyOn(await import('#worker/repo/repo-session-do.ts'), 'repoSessionRpc')
		.mockReturnValue(sessionClient as never)
	const formatJobErrorSpy = vi.spyOn(
		await import('./schedule.ts'),
		'formatJobError',
	)
	const executeSpy = vi.spyOn(
		await import('#mcp/run-codemode-registry.ts'),
		'runBundledModuleWithRegistry',
	)

	try {
		const outcome = await executeJobOnce({
			env,
			job,
			callerContext,
		})

		expect(outcome.execution).toEqual({
			ok: false,
			error:
				'Failed to discard stale repo session "job-runtime-job-repo-discard-failure" before refreshing to published commit "commit-1".',
			logs: [],
		})
		expect(sessionClient.openSession).toHaveBeenCalledTimes(1)
		expect(sessionClient.runChecks).not.toHaveBeenCalled()
		expect(executeSpy).not.toHaveBeenCalled()
		expect(formatJobErrorSpy).toHaveBeenCalledTimes(1)
		expect(formatJobErrorSpy.mock.calls[0]?.[0]).toMatchObject({
			message:
				'Failed to discard stale repo session "job-runtime-job-repo-discard-failure" before refreshing to published commit "commit-1".',
			cause: discardFailure,
		})
	} finally {
		repoSessionRpcSpy.mockRestore()
		formatJobErrorSpy.mockRestore()
		executeSpy.mockRestore()
	}
})

test('executeJobOnce bundles and runs ESM repo-backed job entrypoints', async () => {
	const env = {
		APP_DB: createDatabase(),
		LOADER: {} as WorkerLoader,
	} as Env
	const callerContext = createBaseCallerContext()
	const job: JobRecord = {
		version: 1,
		id: 'job-repo-module',
		userId: callerContext.user.userId,
		name: 'Repo-backed module job',
		code: null,
		sourceId: 'source-job-repo-module',
		publishedCommit: 'commit-abc',
		storageId: 'job:job-repo-module',
		schedule: {
			type: 'once',
			runAt: '2026-04-17T15:00:00Z',
		},
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		createdAt: '2026-04-16T00:00:00.000Z',
		updatedAt: '2026-04-16T00:00:00.000Z',
		nextRunAt: '2026-04-17T15:00:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
		runHistory: [],
	}

	const sessionClient = {
		openSession: vi.fn(async () => ({
			id: 'job-runtime-job-repo-module',
			source_id: 'source-job-repo-module',
			source_root: '/',
			base_commit: 'commit-abc',
			session_repo_id: 'session-repo-id',
			session_repo_name: 'session-repo-name',
			session_repo_namespace: 'default',
			conversation_id: null,
			last_checkpoint_commit: null,
			last_check_run_id: null,
			last_check_tree_hash: null,
			expires_at: null,
			created_at: '2026-04-16T00:00:00.000Z',
			updated_at: '2026-04-16T00:00:00.000Z',
			published_commit: 'commit-abc',
			manifest_path: 'package.json',
			entity_type: 'job' as const,
		})),
		runChecks: vi.fn(async () => ({
			ok: true,
			results: [],
			manifest: createPackageJobManifest({
				packageName: '@kody/repo-module-job',
				kodyId: 'repo-module-job',
				description: 'Runs from repo',
				jobName: 'Repo-backed module job',
			}),
		})),
		readFile: vi.fn(async ({ path }: { path: string }) => ({
			path,
			content:
				path === 'package.json'
					? createPackageJobManifestText({
							packageName: '@kody/repo-module-job',
							kodyId: 'repo-module-job',
							description: 'Runs from repo',
							jobName: 'Repo-backed module job',
						})
					: 'export default async () => ({ ok: true })',
		})),
		tree: vi.fn(async () => ({
			path: '',
			name: '',
			type: 'directory' as const,
			size: 0,
			children: [
				{
					path: 'src/job.ts',
					name: 'job.ts',
					type: 'file' as const,
					size: 1,
				},
				{
					path: 'src/lib.ts',
					name: 'lib.ts',
					type: 'file' as const,
					size: 1,
				},
				{
					path: 'package.json',
					name: 'package.json',
					type: 'file' as const,
					size: 1,
				},
			],
		})),
		discardSession: vi.fn(async () => ({
			ok: true as const,
			sessionId: 'job-runtime-job-repo-module',
			deleted: true,
		})),
	}

	const repoSessionRpcSpy = vi
		.spyOn(await import('#worker/repo/repo-session-do.ts'), 'repoSessionRpc')
		.mockReturnValue(sessionClient as never)
	const executeSpy = vi.spyOn(
		await import('#mcp/run-codemode-registry.ts'),
		'runBundledModuleWithRegistry',
	)
	const bundleSpy = vi.spyOn(
		await import('#worker/package-runtime/module-graph.ts'),
		'buildKodyModuleBundle',
	)
	const loadFilesSpy = vi.spyOn(
		await import('#worker/repo/repo-codemode-execution.ts'),
		'loadRepoSourceFilesFromSession',
	)

	try {
		loadFilesSpy.mockResolvedValue({
			'package.json': JSON.stringify({
				name: 'repo-module-job',
				private: true,
			}),
			'src/job.ts':
				'export default async () => ({ ok: true, repoBacked: "module" })',
			'src/lib.ts': 'export const value = 1',
		})
		bundleSpy.mockResolvedValue({
			mainModule: 'dist/job.js',
			modules: {
				'dist/job.js':
					'export default async () => ({ ok: true, repoBacked: "module" })',
			},
		})
		executeSpy.mockResolvedValue({
			result: { ok: true, repoBacked: 'module' },
			logs: ['repo-backed codemode executed'],
		})
		const outcome = await executeJobOnce({
			env,
			job,
			callerContext,
		})

		expect(outcome.execution).toEqual({
			ok: true,
			result: { ok: true, repoBacked: 'module' },
			logs: ['repo-backed codemode executed'],
		})
		expect(loadFilesSpy).toHaveBeenCalledWith({
			sessionClient,
			sessionId: 'job-runtime-job-repo-module',
			userId: 'user-123',
			sourceRoot: '/',
		})
		expect(bundleSpy).toHaveBeenCalledWith({
			env,
			baseUrl: 'https://example.com',
			userId: 'user-123',
			sourceFiles: {
				'package.json': JSON.stringify({
					name: 'repo-module-job',
					private: true,
				}),
				'src/job.ts':
					'export default async () => ({ ok: true, repoBacked: "module" })',
				'src/lib.ts': 'export const value = 1',
			},
			entryPoint: 'src/job.ts',
			params: undefined,
		})
		expect(executeSpy).toHaveBeenCalledTimes(1)
		expect(executeSpy.mock.calls[0]?.[0]).toBe(env)
		expect(executeSpy.mock.calls[0]?.[1]).toMatchObject({
			repoContext: expect.objectContaining({
				sourceId: 'source-job-repo-module',
				sessionId: 'job-runtime-job-repo-module',
			}),
		})
		expect(executeSpy.mock.calls[0]?.[2]).toMatchObject({
			mainModule: 'dist/job.js',
			modules: {
				'dist/job.js':
					'export default async () => ({ ok: true, repoBacked: "module" })',
			},
		})
		expect(executeSpy.mock.calls[0]?.[3]).toBeUndefined()
		expect(executeSpy.mock.calls[0]?.[4]).toMatchObject({
			storageTools: {
				userId: 'user-123',
				storageId: 'job:job-repo-module',
				writable: true,
			},
			packageContext: {
				packageId: 'job-repo-module',
				kodyId: 'repo-module-job',
			},
		})
		const openedSessionId = sessionClient.openSession.mock.calls[0]?.[0]?.sessionId
		expect(openedSessionId).toMatch(/^job-runtime-job-repo-module-/)
		expect(sessionClient.discardSession).toHaveBeenCalledWith({
			sessionId: openedSessionId,
			userId: 'user-123',
		})
	} finally {
		repoSessionRpcSpy.mockRestore()
		executeSpy.mockRestore()
		bundleSpy.mockRestore()
		loadFilesSpy.mockRestore()
	}
})

test('executeJobOnce returns an error when codemode secret policy would reject execution', async () => {
	const env = {
		APP_DB: createDatabase(),
		LOADER: {} as WorkerLoader,
	} as Env
	const callerContext = createBaseCallerContext()
	const job: JobRecord = {
		version: 1,
		id: 'job-1',
		userId: callerContext.user.userId,
		name: 'Forbidden secret access',
		sourceId: 'source-secret-policy',
		publishedCommit: 'commit-secret-policy',
		storageId: 'job:job-1',
		schedule: {
			type: 'once',
			runAt: '2026-04-17T15:00:00Z',
		},
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		createdAt: '2026-04-16T00:00:00.000Z',
		updatedAt: '2026-04-16T00:00:00.000Z',
		nextRunAt: '2026-04-17T15:00:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
		runHistory: [],
	}

	const executeSpy = vi
		.spyOn(
			await import('#mcp/run-codemode-registry.ts'),
			'runBundledModuleWithRegistry',
		)
		.mockResolvedValue({
			error: createCapabilitySecretAccessDeniedMessage(
				'apiToken',
				'secret_set',
				'https://example.com/account/secrets/user/apiToken?capability=secret_set',
			),
			logs: [],
		})

	try {
		const sessionClient = {
			openSession: vi.fn(async () => ({
				id: 'job-runtime-job-1',
				source_id: 'source-secret-policy',
				source_root: '/',
				base_commit: 'commit-secret-policy',
				session_repo_id: 'session-repo-secret-policy',
				session_repo_name: 'session-repo-name',
				session_repo_namespace: 'default',
				conversation_id: null,
				last_checkpoint_commit: null,
				last_check_run_id: null,
				last_check_tree_hash: null,
				expires_at: null,
				created_at: '2026-04-16T00:00:00.000Z',
				updated_at: '2026-04-16T00:00:00.000Z',
				published_commit: 'commit-secret-policy',
				manifest_path: 'package.json',
				entity_type: 'job' as const,
			})),
			runChecks: vi.fn(async () => ({
				ok: true,
				results: [],
				manifest: createPackageJobManifest({
					packageName: '@kody/forbidden-secret-access',
					kodyId: 'forbidden-secret-access',
					description: 'Runs from repo',
					jobName: 'Forbidden secret access',
				}),
			})),
			readFile: vi.fn(async ({ path }: { path: string }) => ({
				path,
				content:
					path === 'package.json'
						? createPackageJobManifestText({
								packageName: '@kody/forbidden-secret-access',
								kodyId: 'forbidden-secret-access',
								description: 'Runs from repo',
								jobName: 'Forbidden secret access',
							})
						: 'export default async () => ({ ok: true })',
			})),
			tree: vi.fn(async () => ({
				path: '',
				name: '',
				type: 'directory' as const,
				size: 0,
				children: [
					{
						path: 'src/job.ts',
						name: 'job.ts',
						type: 'file' as const,
						size: 1,
					},
				],
			})),
			discardSession: vi.fn(),
		}
		const repoSessionRpcSpy = vi
			.spyOn(await import('#worker/repo/repo-session-do.ts'), 'repoSessionRpc')
			.mockReturnValue(sessionClient as never)
		const outcome = await executeJobOnce({
			env,
			job,
			callerContext,
		})
		expect(outcome.execution).toEqual({
			ok: false,
			error:
				'Secret "apiToken" is not allowed for capability "secret_set". If this capability should be able to use the secret, ask the user whether to add "secret_set" to the secret\'s allowed capabilities in the account secrets UI, then retry after they approve that policy change. Approval link: https://example.com/account/secrets/user/apiToken?capability=secret_set',
			logs: [],
		})
		repoSessionRpcSpy.mockRestore()
	} finally {
		executeSpy.mockRestore()
	}
})

test('runJobNow deletes vectors for once jobs', async () => {
	const db = createDatabase()
	const env = {
		APP_DB: db,
		LOADER: {} as WorkerLoader,
		REPO_SESSION: {} as DurableObjectNamespace,
	} as Env & { CAPABILITY_VECTOR_INDEX?: Pick<VectorizeIndex, 'deleteByIds'> }
	mockRepoPersistence()
	const callerContext = createBaseCallerContext()
	const jobView = await createJob({
		env,
		callerContext,
		body: {
			name: 'Run once and delete vector',
			code: 'export default async () => ({ ok: true })',
			schedule: {
				type: 'once',
				runAt: '2026-04-17T15:00:00Z',
			},
		},
	})
	const deleteByIds = vi.fn(async () => {})
	env.CAPABILITY_VECTOR_INDEX = {
		deleteByIds,
	}
	const sessionClient = {
		openSession: vi.fn(async () => ({
			id: `job-runtime-${jobView.id}`,
			source_id: `${jobView.id}`,
			source_root: '/',
			base_commit: 'published-commit-1',
			session_repo_id: 'session-repo-run-once',
			session_repo_name: 'session-repo-name',
			session_repo_namespace: 'default',
			conversation_id: null,
			last_checkpoint_commit: null,
			last_check_run_id: null,
			last_check_tree_hash: null,
			expires_at: null,
			created_at: '2026-04-16T00:00:00.000Z',
			updated_at: '2026-04-16T00:00:00.000Z',
			published_commit: 'published-commit-1',
			manifest_path: 'package.json',
			entity_type: 'job' as const,
		})),
		runChecks: vi.fn(async () => ({
			ok: true,
			results: [],
			manifest: {
				name: '@kody/run-once',
				exports: {
					'.': './src/index.ts',
				},
				kody: {
					id: 'run-once',
					description: 'Runs from repo',
					jobs: {
						'Run once and delete vector': {
							entry: './src/job.ts',
							schedule: {
								type: 'once',
								runAt: '2026-04-17T15:00:00Z',
							},
						},
					},
				},
			},
		})),
		readFile: vi.fn(async ({ path }: { path: string }) => ({
			path,
			content:
				path === 'package.json'
					? JSON.stringify({
							name: '@kody/run-once',
							exports: {
								'.': './src/index.ts',
							},
							kody: {
								id: 'run-once',
								description: 'Runs from repo',
								jobs: {
									'Run once and delete vector': {
										entry: './src/job.ts',
										schedule: {
											type: 'once',
											runAt: '2026-04-17T15:00:00Z',
										},
									},
								},
							},
						})
					: 'export default async () => ({ ok: true })',
		})),
		tree: vi.fn(async () => ({
			path: '',
			name: '',
			type: 'directory' as const,
			size: 0,
			children: [
				{
					path: 'src/job.ts',
					name: 'job.ts',
					type: 'file' as const,
					size: 1,
				},
			],
		})),
		discardSession: vi.fn(),
	}
	const repoSessionRpcSpy = vi
		.spyOn(await import('#worker/repo/repo-session-do.ts'), 'repoSessionRpc')
		.mockReturnValue(sessionClient as never)
	const executeSpy = vi
		.spyOn(
			await import('#mcp/run-codemode-registry.ts'),
			'runBundledModuleWithRegistry',
		)
		.mockResolvedValue({
			result: { ok: true },
			logs: [],
		})

	try {
		const result = await runJobNow({
			env: env as Env,
			userId: callerContext.user.userId,
			jobId: jobView.id,
			callerContext,
		})
		expect(result.execution).toEqual({
			ok: true,
			result: { ok: true },
			logs: [],
		})
		expect(deleteByIds).toHaveBeenCalledWith([`job_${jobView.id}`])
		const row = await (
			await import('./repo.ts')
		).getJobRowById(db, callerContext.user.userId, jobView.id)
		expect(row).toBeNull()
	} finally {
		repoSessionRpcSpy.mockRestore()
		executeSpy.mockRestore()
	}
})

test('runJobNow can use a one-off repo check policy override without changing the stored job', async () => {
	const db = createDatabase()
	const env = {
		APP_DB: db,
		LOADER: {} as WorkerLoader,
	} as Env
	const callerContext = createBaseCallerContext()
	mockRepoPersistence()
	const jobView = await createJob({
		env,
		callerContext,
		body: {
			name: 'Repo-backed run-now override',
			code: 'export default async () => ({ ok: true })',
			sourceId: 'source-run-now-override',
			publishedCommit: 'commit-run-now-override',
			schedule: {
				type: 'interval',
				every: '15m',
			},
		},
	})

	const sessionClient = {
		openSession: vi.fn(async () => ({
			id: `job-runtime-${jobView.id}`,
			source_id: 'source-run-now-override',
			source_root: '/',
			base_commit: 'commit-run-now-override',
			session_repo_id: 'session-repo-run-now-override',
			session_repo_name: 'session-repo-name',
			session_repo_namespace: 'default',
			conversation_id: null,
			last_checkpoint_commit: null,
			last_check_run_id: null,
			last_check_tree_hash: null,
			expires_at: null,
			created_at: '2026-04-16T00:00:00.000Z',
			updated_at: '2026-04-16T00:00:00.000Z',
			published_commit: 'commit-run-now-override',
			manifest_path: 'package.json',
			entity_type: 'job' as const,
		})),
		runChecks: vi.fn(async () => ({
			ok: false,
			results: [
				{
					kind: 'typecheck' as const,
					ok: false,
					message: "src/job.ts:1:28 Cannot find name 'codemode'.",
				},
			],
			manifest: {
				name: '@kody/run-now-override',
				exports: {
					'.': './src/index.ts',
				},
				kody: {
					id: 'run-now-override',
					description: 'Runs from repo',
					jobs: {
						'Repo-backed run-now override': {
							entry: './src/job.ts',
							schedule: {
								type: 'interval',
								every: '15m',
							},
						},
					},
				},
			},
			runId: 'check-run-run-now-override',
			treeHash: 'tree-hash-run-now-override',
			checkedAt: '2026-04-16T00:00:00.000Z',
		})),
		readFile: vi.fn(async ({ path }: { path: string }) => ({
			path,
			content:
				path === 'package.json'
					? JSON.stringify({
							name: '@kody/run-now-override',
							exports: {
								'.': './src/index.ts',
							},
							kody: {
								id: 'run-now-override',
								description: 'Runs from repo',
								jobs: {
									'Repo-backed run-now override': {
										entry: './src/job.ts',
										schedule: {
											type: 'interval',
											every: '15m',
										},
									},
								},
							},
						})
					: 'export default async () => ({ ok: true, override: true })',
		})),
		tree: vi.fn(async () => ({
			path: '',
			name: '',
			type: 'directory' as const,
			size: 0,
			children: [
				{
					path: 'src/job.ts',
					name: 'job.ts',
					type: 'file' as const,
					size: 1,
				},
			],
		})),
		discardSession: vi.fn(),
	}

	const repoSessionRpcSpy = vi
		.spyOn(await import('#worker/repo/repo-session-do.ts'), 'repoSessionRpc')
		.mockReturnValue(sessionClient as never)
	const executeSpy = vi
		.spyOn(
			await import('#mcp/run-codemode-registry.ts'),
			'runBundledModuleWithRegistry',
		)
		.mockResolvedValue({
			result: { ok: true, override: true },
			logs: ['repo-backed codemode executed'],
		})

	try {
		const result = await runJobNow({
			env,
			userId: callerContext.user.userId,
			jobId: jobView.id,
			callerContext,
			repoCheckPolicyOverride: {
				allowTypecheckFailures: true,
			},
		})

		expect(result.execution).toEqual({
			ok: true,
			result: { ok: true, override: true },
			logs: [
				`Bypassed repo typecheck-only check failures for job "${jobView.id}" (source "source-run-now-override", check run check-run-run-now-override).`,
				'repo-backed codemode executed',
			],
		})
		const row = await (
			await import('./repo.ts')
		).getJobRowById(db, callerContext.user.userId, jobView.id)
		expect(row?.record.repoCheckPolicy).toBeUndefined()
		expect(executeSpy).toHaveBeenCalledTimes(1)
	} finally {
		repoSessionRpcSpy.mockRestore()
		executeSpy.mockRestore()
	}
})
