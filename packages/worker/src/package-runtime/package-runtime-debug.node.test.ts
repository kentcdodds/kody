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

test('package runtime debug records runs, enforces log limits, and surfaces errors', async () => {
	const env = { APP_DB: createDebugDatabase() } as Env
	const successRun = await beginPackageRuntimeRun({
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
		handle: successRun,
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
	const loadedSuccess = await getPackageRuntimeRun({
		env,
		userId: 'user-1',
		runId: listed[0]?.id ?? '',
	})
	expect(loadedSuccess?.logs.map((log) => log.message)).toEqual([
		'starting sync',
		'finished sync',
	])

	const errorRun = await beginPackageRuntimeRun({
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
		handle: errorRun,
		status: 'error',
		error: { name: 'ServiceError', message: 'boom' },
	})
	const listedAfterError = await listPackageRuntimeRuns({
		env,
		userId: 'user-1',
	})
	expect(listedAfterError[0]).toMatchObject({
		status: 'error',
		errorName: 'ServiceError',
		errorMessage: 'boom',
	})

	const truncationRun = await beginPackageRuntimeRun({
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
		handle: truncationRun,
		status: 'success',
		logs: ['😀'.repeat(20_000)],
	})
	const loadedTruncated = await getPackageRuntimeRun({
		env,
		userId: 'user-1',
		runId: truncationRun?.id ?? '',
	})
	const truncatedMessage = loadedTruncated?.logs[0]?.message ?? ''
	expect(new TextEncoder().encode(truncatedMessage).length).toBeLessThanOrEqual(
		16 * 1024,
	)
	expect(truncatedMessage.endsWith('... [truncated]')).toBe(true)

	const metadataRun = await beginPackageRuntimeRun({
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
		handle: metadataRun,
		status: 'success',
	})
	const listedAfterMetadata = await listPackageRuntimeRuns({
		env,
		userId: 'user-1',
	})
	const metadataRow = listedAfterMetadata.find(
		(row) => row.id === metadataRun?.id,
	)
	expect(metadataRow?.metadata).toMatchObject({
		__truncated__: true,
	})
	expect(metadataRow?.metadata['preview']).toEqual(expect.any(String))

	const cappedRun = await beginPackageRuntimeRun({
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
		handle: cappedRun,
		status: 'success',
		logs: Array.from({ length: 205 }, (_, index) => `line-${index}`),
	})
	const loadedCapped = await getPackageRuntimeRun({
		env,
		userId: 'user-1',
		runId: cappedRun?.id ?? '',
	})
	expect(loadedCapped?.logs).toHaveLength(200)
	expect(loadedCapped?.logs[0]).toMatchObject({
		sequence: 0,
		message: 'line-5',
	})
	expect(loadedCapped?.logs.at(-1)).toMatchObject({
		sequence: 199,
		message: 'line-204',
	})

	const failingLogEnv = {
		APP_DB: createDebugDatabase({ failLogInsert: true }),
	} as Env
	const logFailureRun = await beginPackageRuntimeRun({
		env: failingLogEnv,
		userId: 'user-1',
		context: {
			packageId: 'pkg-1',
			kodyId: 'calendar-agent',
			surface: 'export',
			name: './sync',
		},
	})
	await finishPackageRuntimeRun({
		env: failingLogEnv,
		handle: logFailureRun,
		status: 'success',
		logs: ['log write will fail'],
	})
	const listedAfterLogFailure = await listPackageRuntimeRuns({
		env: failingLogEnv,
		userId: 'user-1',
	})
	expect(listedAfterLogFailure[0]).toMatchObject({
		status: 'success',
		name: './sync',
	})
	const loadedAfterLogFailure = await getPackageRuntimeRun({
		env: failingLogEnv,
		userId: 'user-1',
		runId: logFailureRun?.id ?? '',
	})
	expect(loadedAfterLogFailure?.logs).toEqual([])
})
