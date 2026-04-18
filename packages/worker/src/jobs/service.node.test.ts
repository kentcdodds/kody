import { expect, test, vi } from 'vitest'
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

function createDatabase() {
	const tables = new Map<string, Array<Record<string, unknown>>>([
		['secret_buckets', []],
		['secret_entries', []],
		['value_buckets', []],
		['value_entries', []],
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
									code: params[3],
									source_id: params[4],
									published_commit: params[5],
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
									code: params[1],
									source_id: params[2],
									published_commit: params[3],
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
	const callerContext = createBaseCallerContext()

	const result = await createJob({
		env,
		callerContext,
		body: {
			name: 'Deploy Worker',
			code: 'async () => ({ ok: true })',
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
	const callerContext = createBaseCallerContext()

	const created = await createJob({
		env,
		callerContext,
		body: {
			name: 'Storage-backed job',
			code: 'async () => ({ ok: true })',
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
	const callerContext = createBaseCallerContext()

	const jobView = await createJob({
		env,
		callerContext,
		body: {
			name: 'Storage bridge',
			code: 'async (params) => { await storage.set("count", params.stepCount); return await storage.sql("select 2 as value") }',
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
			'runCodemodeWithRegistry',
		)
		.mockResolvedValue({
			result: {
				value: 2,
			},
			logs: ['storage helper executed'],
		})

	try {
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
	} as unknown as Env
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
			code: 'async () => ({ ok: true })',
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
			'runCodemodeWithRegistry',
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
			repoContext: null,
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
		code: null,
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
				manifest_path: 'kody.json',
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
				manifest_path: 'kody.json',
				entity_type: 'job',
			}),
		runChecks: vi.fn(async () => ({
			ok: true,
			results: [],
			manifest: {
				version: 1,
				kind: 'job',
				title: 'Repo-backed job',
				description: 'Runs from repo',
				entrypoint: '/src/job.ts',
			},
		})),
		readFile: vi.fn(async ({ path }: { path: string }) => ({
			path,
			content:
				path === 'kody.json'
					? JSON.stringify({
							version: 1,
							kind: 'job',
							title: 'Repo-backed job',
							description: 'Runs from repo',
							entrypoint: '/src/job.ts',
						})
					: 'async () => ({ ok: true, repoBacked: true })',
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
			'runCodemodeWithRegistry',
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
		expect(sessionClient.openSession).toHaveBeenNthCalledWith(1, {
			sessionId: 'job-runtime-job-repo-1',
			sourceId: 'source-1',
			userId: 'user-123',
			baseUrl: 'https://example.com',
			sourceRoot: '/',
		})
		expect(sessionClient.openSession).toHaveBeenNthCalledWith(2, {
			sessionId: 'job-runtime-job-repo-1',
			sourceId: 'source-1',
			userId: 'user-123',
			baseUrl: 'https://example.com',
			sourceRoot: '/',
		})
		expect(sessionClient.runChecks).toHaveBeenCalledWith({
			sessionId: 'job-runtime-job-repo-1',
			userId: 'user-123',
		})
		expect(sessionClient.discardSession).toHaveBeenCalledWith({
			sessionId: 'job-runtime-job-repo-1',
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
			manifest_path: 'kody.json',
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
		'runCodemodeWithRegistry',
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

test('executeJobOnce returns a clear error for module-style repo-backed job entrypoints', async () => {
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
			manifest_path: 'kody.json',
			entity_type: 'job' as const,
		})),
		runChecks: vi.fn(async () => ({
			ok: true,
			results: [],
			manifest: {
				version: 1,
				kind: 'job',
				title: 'Repo-backed module job',
				description: 'Runs from repo',
				entrypoint: 'src/job.ts',
			},
		})),
		readFile: vi.fn(async ({ path }: { path: string }) => ({
			path,
			content:
				path === 'kody.json'
					? JSON.stringify({
							version: 1,
							kind: 'job',
							title: 'Repo-backed module job',
							description: 'Runs from repo',
							entrypoint: 'src/job.ts',
						})
					: 'export default async () => ({ ok: true })',
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
		'runCodemodeWithRegistry',
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
				'Repo-backed job entrypoints must be execute-compatible async function snippets, not ESM/CommonJS modules.',
			logs: [],
		})
		expect(executeSpy).not.toHaveBeenCalled()
		expect(sessionClient.discardSession).not.toHaveBeenCalled()
	} finally {
		repoSessionRpcSpy.mockRestore()
		executeSpy.mockRestore()
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
		code: 'async () => null',
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
			'runCodemodeWithRegistry',
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
	} finally {
		executeSpy.mockRestore()
	}
})

test('runJobNow deletes vectors for once jobs', async () => {
	const db = createDatabase()
	const env = {
		APP_DB: db,
		LOADER: {} as WorkerLoader,
	} as Env & { CAPABILITY_VECTOR_INDEX?: Pick<VectorizeIndex, 'deleteByIds'> }
	const callerContext = createBaseCallerContext()
	const jobView = await createJob({
		env,
		callerContext,
		body: {
			name: 'Run once and delete vector',
			code: 'async () => ({ ok: true })',
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
	const executeSpy = vi
		.spyOn(
			await import('#mcp/run-codemode-registry.ts'),
			'runCodemodeWithRegistry',
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
		executeSpy.mockRestore()
	}
})
