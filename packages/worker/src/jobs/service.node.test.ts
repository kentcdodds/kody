import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { createJob, executeJobOnce } from './service.ts'
import { type JobCreateInput, type JobRecord, type PersistedJobCallerContext } from './types.ts'

function createDatabase() {
	const tables = new Map<string, Array<Record<string, unknown>>>([['jobs', []]])

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

	return {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async first<T = Record<string, unknown>>() {
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
							throw new Error(`Unsupported all query: ${query}`)
						},
						async run() {
							if (query.startsWith('INSERT INTO jobs')) {
								const row = {
									id: params[0],
									user_id: params[1],
									name: params[2],
									source_id: params[3],
									published_commit: params[4],
									storage_id: params[5],
									params_json: params[6],
									schedule_json: params[7],
									timezone: params[8],
									enabled: params[9],
									kill_switch_enabled: params[10],
									caller_context_json: params[11],
									created_at: params[12],
									updated_at: params[13],
									last_run_at: params[14],
									last_run_status: params[15],
									last_run_error: params[16],
									last_duration_ms: params[17],
									next_run_at: params[18],
									run_count: params[19],
									success_count: params[20],
									error_count: params[21],
									run_history_json: params[22],
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
									id: params[20],
									user_id: params[21],
									name: params[0],
									source_id: params[1],
									published_commit: params[2],
									storage_id: params[3],
									params_json: params[4],
									schedule_json: params[5],
									timezone: params[6],
									enabled: params[7],
									kill_switch_enabled: params[8],
									caller_context_json: params[9],
									updated_at: params[10],
									last_run_at: params[11],
									last_run_status: params[12],
									last_run_error: params[13],
									last_duration_ms: params[14],
									next_run_at: params[15],
									run_count: params[16],
									success_count: params[17],
									error_count: params[18],
									run_history_json: params[19],
									created_at:
										selectOne(
											'jobs',
											(existing) =>
												existing['id'] === params[20] &&
												existing['user_id'] === params[21],
										)?.['created_at'] ?? params[10],
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
								const table = getTable('jobs')
								const before = table.length
								const remaining = table.filter(
									(row) =>
										!(
											row['id'] === params[0] &&
											row['user_id'] === params[1]
										),
								)
								tables.set('jobs', remaining)
								return {
									meta: { changes: before - remaining.length, last_row_id: 0 },
								}
							}
							if (query.startsWith('INSERT INTO entity_sources')) {
								return { meta: { changes: 1, last_row_id: 0 } }
							}
							if (query.startsWith('UPDATE entity_sources')) {
								return { meta: { changes: 1, last_row_id: 0 } }
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

test('createJob publishes repo-backed code and stores projection metadata', async () => {
	const env = {
		APP_DB: createDatabase(),
		ARTIFACTS: {},
		REPO_SESSION: {},
	} as Env
	const callerContext = createBaseCallerContext()

	const ensureEntitySourceSpy = vi
		.spyOn(await import('#worker/repo/source-service.ts'), 'ensureEntitySource')
		.mockResolvedValue({
			id: 'source-job-1',
			user_id: 'user-123',
			entity_kind: 'job',
			entity_id: 'job-1',
			repo_id: 'repo-1',
			published_commit: null,
			indexed_commit: null,
			manifest_path: 'kody.json',
			source_root: '/',
			created_at: '2026-04-17T00:00:00.000Z',
			updated_at: '2026-04-17T00:00:00.000Z',
		})
	const syncSpy = vi
		.spyOn(await import('#worker/repo/source-sync.ts'), 'syncArtifactSourceSnapshot')
		.mockResolvedValue('commit-job-1')
	const setEntityPublishedCommitSpy = vi
		.spyOn(
			await import('#worker/repo/source-service.ts'),
			'setEntityPublishedCommit',
		)
		.mockResolvedValue(true)

	try {
		const result = await createJob({
			env,
			callerContext,
			body: {
				name: 'Deploy Worker',
				sourceId: 'source-job-1',
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
		expect(result.sourceId).toBe('source-job-1')
		expect(result.publishedCommit).toBe('commit-job-1')
		expect(result.scheduleSummary).toBe('Runs every 15m')
		expect(syncSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceId: 'source-job-1',
				files: expect.objectContaining({
					'kody.json': expect.any(String),
					'src/job.ts': 'async () => ({ ok: true })\n',
				}),
			}),
		)
		expect(setEntityPublishedCommitSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceId: 'source-job-1',
				publishedCommit: 'commit-job-1',
			}),
		)
		expect(ensureEntitySourceSpy).toHaveBeenCalled()
	} finally {
		ensureEntitySourceSpy.mockRestore()
		syncSpy.mockRestore()
		setEntityPublishedCommitSpy.mockRestore()
	}
})

test('createJob rejects jobs when repo source support is unavailable', async () => {
	const env = {
		APP_DB: createDatabase(),
	} as Env
	const callerContext = createBaseCallerContext()

	await expect(
		createJob({
			env,
			callerContext,
			body: {
				name: 'Repo-backed job without bindings',
				sourceId: 'source-1',
				code: 'async () => ({ ok: true })',
				schedule: {
					type: 'once',
					runAt: '2026-04-17T15:00:00Z',
				},
			},
		}),
	).rejects.toThrow(
		'Repo-backed source support is unavailable in this environment. Missing required bindings: ARTIFACTS, REPO_SESSION.',
	)
})

test('executeJobOnce runs repo-backed jobs with writable storage tools', async () => {
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
		openSession: vi.fn(async () => ({
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
			entity_type: 'job' as const,
		})),
		runChecks: vi.fn(async () => ({
			ok: true,
			results: [],
			manifest: {
				version: 1,
				kind: 'job',
				title: 'Repo-backed job',
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
							title: 'Repo-backed job',
							description: 'Runs from repo',
							entrypoint: 'src/job.ts',
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
		expect(executeSpy).toHaveBeenCalledTimes(1)
		expect(executeSpy.mock.calls[0]?.[3]).toEqual(undefined)
		expect(executeSpy.mock.calls[0]?.[4]).toEqual(
			expect.objectContaining({
				storageTools: {
					userId: 'user-123',
					storageId: 'job:job-repo-1',
					writable: true,
				},
			}),
		)
	} finally {
		repoSessionRpcSpy.mockRestore()
		executeSpy.mockRestore()
	}
})
