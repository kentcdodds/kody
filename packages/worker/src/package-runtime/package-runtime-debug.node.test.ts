import { expect, test } from 'vitest'
import {
	beginPackageRuntimeRun,
	finishPackageRuntimeRun,
	getPackageRuntimeRun,
	listPackageRuntimeRuns,
} from './package-runtime-debug.ts'

function createDebugDatabase(options: { failLogInsert?: boolean } = {}) {
	const runs: Array<Record<string, unknown>> = []
	const logs: Array<Record<string, unknown>> = []
	const selectRows = (query: string, params: Array<unknown>) => {
		let rows = runs.filter((row) => row['user_id'] === params[0])
		let offset = 1
		if (query.includes('package_id = ?')) {
			rows = rows.filter((row) => row['package_id'] === params[offset])
			offset += 1
		}
		if (query.includes('surface = ?')) {
			rows = rows.filter((row) => row['surface'] === params[offset])
			offset += 1
		}
		const limit = Number(params[offset]) || 25
		return rows
			.toSorted(
				(left, right) =>
					String(right['started_at']).localeCompare(
						String(left['started_at']),
					) || String(right['id']).localeCompare(String(left['id'])),
			)
			.slice(0, limit)
	}
	const db = {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async run() {
							if (query.includes('INSERT INTO package_runtime_runs')) {
								runs.push({
									id: params[0],
									user_id: params[1],
									package_id: params[2],
									package_kody_id: params[3],
									source_id: params[4],
									published_commit: params[5],
									surface: params[6],
									name: params[7],
									status: 'running',
									started_at: params[8],
									finished_at: null,
									duration_ms: null,
									error_name: null,
									error_message: null,
									storage_id: params[9],
									job_id: params[10],
									workflow_id: params[11],
									invocation_id: params[12],
									session_id: params[13],
									idempotency_key: params[14],
									parent_run_id: params[15],
									metadata_json: params[16],
									created_at: params[17],
									updated_at: params[18],
								})
							}
							if (
								query.includes('INSERT OR REPLACE INTO package_runtime_logs')
							) {
								if (options.failLogInsert) {
									throw new Error('log insert failed')
								}
								logs.push({
									id: params[0],
									run_id: params[1],
									user_id: params[2],
									package_id: params[3],
									timestamp: params[4],
									sequence: params[5],
									level: params[6],
									message: params[7],
									fields_json: null,
									created_at: params[8],
								})
							}
							if (query.includes('UPDATE package_runtime_runs')) {
								const row = runs.find(
									(candidate) =>
										candidate['id'] === params[6] &&
										candidate['user_id'] === params[7],
								)
								if (row) {
									row['status'] = params[0]
									row['finished_at'] = params[1]
									row['duration_ms'] = params[2]
									row['error_name'] = params[3]
									row['error_message'] = params[4]
									row['updated_at'] = params[5]
								}
							}
							return { meta: { changes: 1 } }
						},
						async all<T = Record<string, unknown>>() {
							if (query.includes('FROM package_runtime_logs')) {
								return {
									results: logs
										.filter(
											(row) =>
												row['run_id'] === params[0] &&
												row['user_id'] === params[1],
										)
										.toSorted(
											(left, right) =>
												Number(left['sequence']) - Number(right['sequence']),
										) as Array<T>,
								}
							}
							return {
								results: selectRows(query, params) as Array<T>,
							}
						},
						async first<T = Record<string, unknown>>() {
							const row = runs.find(
								(candidate) =>
									candidate['id'] === params[0] &&
									candidate['user_id'] === params[1],
							)
							return (row ?? null) as T | null
						},
					}
				},
			}
		},
	} as unknown as D1Database
	return db
}

test('records, lists, and loads retained package runtime logs', async () => {
	const env = { APP_DB: createDebugDatabase() } as Env
	const run = await beginPackageRuntimeRun({
		env,
		userId: 'user-1',
		context: {
			packageId: 'pkg-1',
			kodyId: 'calendar-agent',
			sourceId: 'source-1',
			publishedCommit: 'abc123',
			surface: 'export',
			name: './sync',
			storageId: 'package:pkg-1',
			invocationId: 'invoke-1',
			idempotencyKey: 'key-1',
			metadata: { topic: 'manual' },
		},
	})

	await finishPackageRuntimeRun({
		env,
		handle: run,
		status: 'success',
		logs: ['starting sync', 'finished sync'],
	})

	const listed = await listPackageRuntimeRuns({
		env,
		userId: 'user-1',
		packageId: 'pkg-1',
		surface: 'export',
	})
	expect(listed).toHaveLength(1)
	expect(listed[0]).toMatchObject({
		packageId: 'pkg-1',
		kodyId: 'calendar-agent',
		surface: 'export',
		status: 'success',
		name: './sync',
		metadata: { topic: 'manual' },
	})

	const loaded = await getPackageRuntimeRun({
		env,
		userId: 'user-1',
		runId: listed[0]?.id ?? '',
	})
	expect(loaded?.logs.map((log) => log.message)).toEqual([
		'starting sync',
		'finished sync',
	])
})

test('records normalized error details', async () => {
	const env = { APP_DB: createDebugDatabase() } as Env
	const run = await beginPackageRuntimeRun({
		env,
		userId: 'user-1',
		context: {
			packageId: 'pkg-1',
			kodyId: 'calendar-agent',
			surface: 'service',
			name: 'daemon',
		},
	})

	await finishPackageRuntimeRun({
		env,
		handle: run,
		status: 'error',
		error: { name: 'ServiceError', message: 'boom' },
	})

	const listed = await listPackageRuntimeRuns({
		env,
		userId: 'user-1',
	})
	expect(listed[0]).toMatchObject({
		status: 'error',
		errorName: 'ServiceError',
		errorMessage: 'boom',
	})
})

test('truncates large UTF-8 log entries within the byte limit', async () => {
	const env = { APP_DB: createDebugDatabase() } as Env
	const run = await beginPackageRuntimeRun({
		env,
		userId: 'user-1',
		context: {
			packageId: 'pkg-1',
			kodyId: 'calendar-agent',
			surface: 'export',
			name: './sync',
		},
	})

	await finishPackageRuntimeRun({
		env,
		handle: run,
		status: 'success',
		logs: ['😀'.repeat(20_000)],
	})

	const loaded = await getPackageRuntimeRun({
		env,
		userId: 'user-1',
		runId: run?.id ?? '',
	})
	const message = loaded?.logs[0]?.message ?? ''
	expect(new TextEncoder().encode(message).length).toBeLessThanOrEqual(
		16 * 1024,
	)
	expect(message.endsWith('... [truncated]')).toBe(true)
})

test('updates run status when log persistence fails', async () => {
	const env = {
		APP_DB: createDebugDatabase({ failLogInsert: true }),
	} as Env
	const run = await beginPackageRuntimeRun({
		env,
		userId: 'user-1',
		context: {
			packageId: 'pkg-1',
			kodyId: 'calendar-agent',
			surface: 'export',
			name: './sync',
		},
	})

	await finishPackageRuntimeRun({
		env,
		handle: run,
		status: 'success',
		logs: ['log write will fail'],
	})

	const listed = await listPackageRuntimeRuns({
		env,
		userId: 'user-1',
	})
	expect(listed[0]).toMatchObject({
		status: 'success',
		name: './sync',
	})
	const loaded = await getPackageRuntimeRun({
		env,
		userId: 'user-1',
		runId: run?.id ?? '',
	})
	expect(loaded?.logs).toEqual([])
})

test('keeps truncated metadata parseable', async () => {
	const env = { APP_DB: createDebugDatabase() } as Env
	const run = await beginPackageRuntimeRun({
		env,
		userId: 'user-1',
		context: {
			packageId: 'pkg-1',
			kodyId: 'calendar-agent',
			surface: 'export',
			name: './sync',
			metadata: {
				payload: 'x'.repeat(50_000),
			},
		},
	})

	await finishPackageRuntimeRun({
		env,
		handle: run,
		status: 'success',
	})

	const listed = await listPackageRuntimeRuns({
		env,
		userId: 'user-1',
	})
	expect(listed[0]?.metadata).toMatchObject({
		__truncated__: true,
	})
	expect(listed[0]?.metadata['preview']).toEqual(expect.any(String))
})

test('retains the newest log entries when log count exceeds the cap', async () => {
	const env = { APP_DB: createDebugDatabase() } as Env
	const run = await beginPackageRuntimeRun({
		env,
		userId: 'user-1',
		context: {
			packageId: 'pkg-1',
			kodyId: 'calendar-agent',
			surface: 'export',
			name: './sync',
		},
	})

	await finishPackageRuntimeRun({
		env,
		handle: run,
		status: 'success',
		logs: Array.from({ length: 205 }, (_, index) => `line-${index}`),
	})

	const loaded = await getPackageRuntimeRun({
		env,
		userId: 'user-1',
		runId: run?.id ?? '',
	})
	expect(loaded?.logs).toHaveLength(200)
	expect(loaded?.logs[0]).toMatchObject({
		sequence: 0,
		message: 'line-5',
	})
	expect(loaded?.logs.at(-1)).toMatchObject({
		sequence: 199,
		message: 'line-204',
	})
})
