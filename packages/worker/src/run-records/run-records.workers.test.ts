import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { RunLog } from './run-log-do.ts'
import {
	beginRunRecord,
	clearRunRecords,
	finishRunRecord,
	getRunRecord,
	listRunRecords,
	recordRunRecord,
	runLogRpc,
	summarizeRunRecords,
} from './service.ts'
import {
	runRecordMaxLogEntriesPerRun,
	runRecordMaxRunsPerUser,
	runRecordRetentionDays,
	runRecordRetentionEveryNFinishes,
	runRecordStaleRunningTtlMs,
	type RunRecordContext,
	type RunRecordHandle,
} from './types.ts'

function uniqueUserId(label: string) {
	return `run-records-${label}-${crypto.randomUUID()}`
}

function baseContext(overrides?: Partial<RunRecordContext>): RunRecordContext {
	return {
		surface: 'job',
		name: 'example-job',
		...overrides,
	}
}

async function drainWaitUntil(pending: Array<Promise<unknown>>) {
	await Promise.all(pending)
	pending.length = 0
}

async function armRetentionOnNextFinish(userId: string, runCount?: number) {
	const stub = env.RUN_LOG.get(env.RUN_LOG.idFromName(userId))
	await runInDurableObject(stub, async (instance: RunLog, state) => {
		expect(instance).toBeInstanceOf(RunLog)
		state.storage.sql.exec(
			`INSERT INTO run_log_meta (key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			'finishes_since_retention',
			runRecordRetentionEveryNFinishes - 1,
		)
		if (typeof runCount === 'number') {
			state.storage.sql.exec(
				`INSERT INTO run_log_meta (key, value) VALUES (?, ?)
				ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
				'run_count',
				runCount,
			)
		}
	})
}

function insertRunRow(
	state: DurableObjectState,
	input: {
		id: string
		status: 'running' | 'success' | 'error'
		startedAt: string
		finishedAt?: string | null
		name?: string | null
		surface?: string
	},
) {
	const finishedAt = input.finishedAt ?? null
	state.storage.sql.exec(
		`INSERT INTO runs (
			id, surface, status, name, package_id, package_kody_id, source_id,
			published_commit, storage_id, job_id, workflow_id, invocation_id,
			session_id, idempotency_key, parent_run_id, started_at, finished_at,
			duration_ms, error_name, error_message, metadata_json, created_at,
			updated_at
		) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL,
			NULL, NULL, NULL, NULL, NULL, ?, ?, ?, NULL, NULL, '{}', ?, ?)`,
		input.id,
		input.surface ?? 'job',
		input.status,
		input.name ?? null,
		input.startedAt,
		finishedAt,
		finishedAt == null ? null : 1,
		input.startedAt,
		finishedAt ?? input.startedAt,
	)
}

test('eager surface begin then finish writes one successful run', async () => {
	const userId = uniqueUserId('eager-success')
	const pending: Array<Promise<unknown>> = []
	const handle = beginRunRecord({
		env,
		userId,
		context: baseContext({ surface: 'job', jobId: 'job-1' }),
		waitUntil: (promise) => {
			pending.push(promise)
		},
	})
	expect(handle).not.toBeNull()
	await drainWaitUntil(pending)
	await finishRunRecord({
		env,
		handle,
		status: 'success',
		logs: ['done'],
	})
	const page = await listRunRecords({ env, userId })
	expect(page.runs).toHaveLength(1)
	expect(page.runs[0]?.status).toBe('success')
	expect(page.runs[0]?.surface).toBe('job')
	expect(page.runs[0]?.jobId).toBe('job-1')
	expect(page.runs[0]?.logCount).toBe(1)
})

test('finishRunRecord alone still upserts a complete row when startRun never landed', async () => {
	const userId = uniqueUserId('finish-only')
	const handle: RunRecordHandle = {
		id: crypto.randomUUID(),
		userId,
		startedAt: new Date().toISOString(),
		persistence: 'eager',
		context: baseContext({
			surface: 'workflow',
			workflowId: 'wf-1',
			name: 'solo-finish',
		}),
	}
	await finishRunRecord({
		env,
		handle,
		status: 'success',
		logs: [{ level: 'info', message: 'finished without start' }],
	})
	const detail = await getRunRecord({ env, userId, runId: handle.id })
	expect(detail).not.toBeNull()
	expect(detail?.run.status).toBe('success')
	expect(detail?.run.surface).toBe('workflow')
	expect(detail?.run.workflowId).toBe('wf-1')
	expect(detail?.logs).toEqual([
		{
			runId: handle.id,
			sequence: 0,
			level: 'info',
			message: 'finished without start',
			fields: null,
		},
	])
})

test('recordRunRecord writes a terminal row in one call without begin', async () => {
	const userId = uniqueUserId('record-one-shot')
	const handle = await recordRunRecord({
		env,
		userId,
		context: baseContext({
			surface: 'webhook',
			name: 'hook-a',
		}),
		status: 'success',
		logs: ['delivered'],
	})
	expect(handle).not.toBeNull()
	const detail = await getRunRecord({ env, userId, runId: handle!.id })
	expect(detail?.run.status).toBe('success')
	expect(detail?.run.surface).toBe('webhook')
	expect(detail?.run.name).toBe('hook-a')
	expect(detail?.logs).toHaveLength(1)
})

test('finishRunRecord waitUntil does not block the caller', async () => {
	const userId = uniqueUserId('finish-wait-until')
	const handle: RunRecordHandle = {
		id: crypto.randomUUID(),
		userId,
		startedAt: new Date().toISOString(),
		persistence: 'eager',
		context: baseContext({ surface: 'export', name: 'bg-finish' }),
	}
	const pending: Array<Promise<unknown>> = []
	const finishReturn = finishRunRecord({
		env,
		handle,
		status: 'success',
		logs: ['async'],
		waitUntil: (promise) => {
			pending.push(promise)
		},
	})
	await expect(finishReturn).resolves.toBeUndefined()
	expect(pending).toHaveLength(1)
	await drainWaitUntil(pending)
	const detail = await getRunRecord({ env, userId, runId: handle.id })
	expect(detail?.run.status).toBe('success')
})

test('execute surface persists nothing on success and one row on error', async () => {
	const userId = uniqueUserId('execute-policy')
	const successHandle = beginRunRecord({
		env,
		userId,
		context: baseContext({ surface: 'execute', name: 'ok' }),
	})
	expect(successHandle?.persistence).toBe('on-failure')
	await finishRunRecord({
		env,
		handle: successHandle,
		status: 'success',
		logs: ['should not persist'],
	})
	expect(await listRunRecords({ env, userId })).toEqual({
		runs: [],
		nextCursor: null,
	})

	const errorHandle = beginRunRecord({
		env,
		userId,
		context: baseContext({ surface: 'execute', name: 'boom' }),
	})
	await finishRunRecord({
		env,
		handle: errorHandle,
		status: 'error',
		error: new Error('execute failed'),
		logs: ['error log'],
	})
	const page = await listRunRecords({ env, userId })
	expect(page.runs).toHaveLength(1)
	expect(page.runs[0]?.status).toBe('error')
	expect(page.runs[0]?.errorName).toBe('Error')
	expect(page.runs[0]?.errorMessage).toBe('execute failed')
	expect(page.runs[0]?.surface).toBe('execute')
})

test('logs round-trip in sequence order and keep only the newest 200', async () => {
	const userId = uniqueUserId('logs-cap')
	const handle = beginRunRecord({
		env,
		userId,
		context: baseContext({ surface: 'service' }),
	})
	expect(handle).not.toBeNull()
	const totalLogs = runRecordMaxLogEntriesPerRun + 50
	const logs = Array.from({ length: totalLogs }, (_, index) => `log-${index}`)
	await finishRunRecord({
		env,
		handle,
		status: 'success',
		logs,
	})
	const detail = await getRunRecord({
		env,
		userId,
		runId: handle!.id,
	})
	expect(detail).not.toBeNull()
	expect(detail?.logs).toHaveLength(runRecordMaxLogEntriesPerRun)
	expect(detail?.logs[0]?.sequence).toBe(0)
	expect(detail?.logs[0]?.message).toBe('log-50')
	expect(detail?.logs.at(-1)?.sequence).toBe(runRecordMaxLogEntriesPerRun - 1)
	expect(detail?.logs.at(-1)?.message).toBe(`log-${totalLogs - 1}`)
	expect(detail?.run.logCount).toBe(runRecordMaxLogEntriesPerRun)
})

test('listRunRecords filters by surface/status/jobId/name and paginates with cursors', async () => {
	const userId = uniqueUserId('list-filter')
	const startedAtBase = Date.now() - 60_000
	for (let index = 0; index < 5; index += 1) {
		const handle: RunRecordHandle = {
			id: `run-${index}`,
			userId,
			startedAt: new Date(startedAtBase + index * 1000).toISOString(),
			persistence: 'eager',
			context: baseContext({
				surface: index % 2 === 0 ? 'job' : 'export',
				jobId: index < 3 ? 'job-shared' : 'job-other',
				name: index < 2 ? 'shared-name' : `run-${index}`,
			}),
		}
		await finishRunRecord({
			env,
			handle,
			status: index === 1 ? 'error' : 'success',
			error: index === 1 ? new Error('fail') : undefined,
		})
	}

	const jobs = await listRunRecords({
		env,
		userId,
		filter: { surface: 'job' },
	})
	expect(jobs.runs.map((run) => run.id)).toEqual(['run-4', 'run-2', 'run-0'])

	const errors = await listRunRecords({
		env,
		userId,
		filter: { status: 'error' },
	})
	expect(errors.runs.map((run) => run.id)).toEqual(['run-1'])

	const sharedJob = await listRunRecords({
		env,
		userId,
		filter: { jobId: 'job-shared' },
	})
	expect(sharedJob.runs.map((run) => run.id)).toEqual([
		'run-2',
		'run-1',
		'run-0',
	])

	const byName = await listRunRecords({
		env,
		userId,
		filter: { name: 'shared-name' },
	})
	expect(byName.runs.map((run) => run.id)).toEqual(['run-1', 'run-0'])

	const page1 = await listRunRecords({
		env,
		userId,
		limit: 2,
	})
	expect(page1.runs.map((run) => run.id)).toEqual(['run-4', 'run-3'])
	expect(page1.nextCursor).toBeTruthy()

	const page2 = await listRunRecords({
		env,
		userId,
		limit: 2,
		cursor: page1.nextCursor,
	})
	expect(page2.runs.map((run) => run.id)).toEqual(['run-2', 'run-1'])
	expect(page2.nextCursor).toBeTruthy()

	const page3 = await listRunRecords({
		env,
		userId,
		limit: 2,
		cursor: page2.nextCursor,
	})
	expect(page3.runs.map((run) => run.id)).toEqual(['run-0'])
	expect(page3.nextCursor).toBeNull()
})

test('summarizeRunRecords returns totals and per-surface error counts', async () => {
	const userId = uniqueUserId('summarize')
	const startedAtBase = Date.now() - 60_000
	const cases: Array<{
		surface: RunRecordContext['surface']
		status: 'success' | 'error'
	}> = [
		{ surface: 'job', status: 'success' },
		{ surface: 'job', status: 'error' },
		{ surface: 'job', status: 'error' },
		{ surface: 'export', status: 'success' },
		{ surface: 'export', status: 'error' },
	]
	for (const [index, entry] of cases.entries()) {
		const handle: RunRecordHandle = {
			id: crypto.randomUUID(),
			userId,
			startedAt: new Date(startedAtBase + index * 1000).toISOString(),
			persistence: 'eager',
			context: baseContext({ surface: entry.surface, name: `s-${index}` }),
		}
		await finishRunRecord({
			env,
			handle,
			status: entry.status,
			error: entry.status === 'error' ? new Error('x') : undefined,
		})
	}

	const summary = await summarizeRunRecords({
		env,
		userId,
		since: new Date(startedAtBase - 1_000).toISOString(),
	})
	expect(summary.total).toBe(5)
	expect(summary.errors).toBe(3)
	expect(summary.running).toBe(0)
	expect(summary.bySurface).toEqual(
		expect.arrayContaining([
			{ surface: 'export', total: 2, errors: 1 },
			{ surface: 'job', total: 3, errors: 2 },
		]),
	)
})

test('retention deletes successes before errors when over the run cap', async () => {
	const userId = uniqueUserId('retention')
	const stub = env.RUN_LOG.get(env.RUN_LOG.idFromName(userId))
	const baseMs = Date.now() - 3_600_000
	const successCount = runRecordMaxRunsPerUser
	const errorCount = 10
	await runInDurableObject(stub, async (instance: RunLog, state) => {
		expect(instance).toBeInstanceOf(RunLog)
		for (let index = 0; index < successCount; index += 1) {
			const startedAt = new Date(baseMs + index).toISOString()
			insertRunRow(state, {
				id: `success-${index}`,
				status: 'success',
				startedAt,
				finishedAt: startedAt,
			})
		}
		for (let index = 0; index < errorCount; index += 1) {
			const startedAt = new Date(baseMs + successCount + index).toISOString()
			insertRunRow(state, {
				id: `error-${index}`,
				status: 'error',
				startedAt,
				finishedAt: startedAt,
			})
		}
	})
	await armRetentionOnNextFinish(userId, successCount + errorCount)

	const handle: RunRecordHandle = {
		id: 'retention-trigger',
		userId,
		startedAt: new Date(baseMs + runRecordMaxRunsPerUser + 20).toISOString(),
		persistence: 'eager',
		context: baseContext({ surface: 'job', name: 'trigger' }),
	}
	await finishRunRecord({
		env,
		handle,
		status: 'success',
	})

	const rpc = runLogRpc({ env, userId })
	const summary = await rpc.summarize({ since: '1970-01-01T00:00:00.000Z' })
	expect(summary.total).toBe(runRecordMaxRunsPerUser)
	expect(summary.errors).toBe(10)

	const remainingSuccess = await runInDurableObject(
		stub,
		async (_instance: RunLog, state) => {
			return state.storage.sql
				.exec<{ n: number }>(
					`SELECT COUNT(*) AS n FROM runs WHERE status = 'success'`,
				)
				.one().n
		},
	)
	expect(remainingSuccess).toBe(runRecordMaxRunsPerUser - 10)
	const oldestSuccessGone = await runInDurableObject(
		stub,
		async (_instance: RunLog, state) => {
			return state.storage.sql
				.exec<{ n: number }>(
					`SELECT COUNT(*) AS n FROM runs WHERE id = 'success-0'`,
				)
				.one().n
		},
	)
	expect(oldestSuccessGone).toBe(0)
})

test('amortized retention still enforces the age cap', async () => {
	const userId = uniqueUserId('age-retention')
	const stub = env.RUN_LOG.get(env.RUN_LOG.idFromName(userId))
	const oldStartedAt = new Date(
		Date.now() - (runRecordRetentionDays + 2) * 24 * 60 * 60 * 1000,
	).toISOString()
	const recentStartedAt = new Date(Date.now() - 60_000).toISOString()
	await runInDurableObject(stub, async (instance: RunLog, state) => {
		expect(instance).toBeInstanceOf(RunLog)
		insertRunRow(state, {
			id: 'old-success',
			status: 'success',
			startedAt: oldStartedAt,
			finishedAt: oldStartedAt,
		})
		insertRunRow(state, {
			id: 'recent-success',
			status: 'success',
			startedAt: recentStartedAt,
			finishedAt: recentStartedAt,
		})
	})
	await armRetentionOnNextFinish(userId, 2)

	await finishRunRecord({
		env,
		handle: {
			id: 'age-trigger',
			userId,
			startedAt: new Date().toISOString(),
			persistence: 'eager',
			context: baseContext({ surface: 'job', name: 'age-trigger' }),
		},
		status: 'success',
	})

	const ids = (await listRunRecords({ env, userId })).runs.map((run) => run.id)
	expect(ids).toContain('recent-success')
	expect(ids).toContain('age-trigger')
	expect(ids).not.toContain('old-success')
})

test('stale running rows are reconciled to interrupted errors', async () => {
	const userId = uniqueUserId('stale-running')
	const stub = env.RUN_LOG.get(env.RUN_LOG.idFromName(userId))
	const staleStartedAt = new Date(
		Date.now() - runRecordStaleRunningTtlMs - 60_000,
	).toISOString()
	const freshStartedAt = new Date().toISOString()
	await runInDurableObject(stub, async (instance: RunLog, state) => {
		expect(instance).toBeInstanceOf(RunLog)
		insertRunRow(state, {
			id: 'stale-running',
			status: 'running',
			startedAt: staleStartedAt,
			finishedAt: null,
		})
		insertRunRow(state, {
			id: 'fresh-running',
			status: 'running',
			startedAt: freshStartedAt,
			finishedAt: null,
		})
	})
	await armRetentionOnNextFinish(userId, 2)

	await finishRunRecord({
		env,
		handle: {
			id: 'stale-trigger',
			userId,
			startedAt: new Date().toISOString(),
			persistence: 'eager',
			context: baseContext({ surface: 'job', name: 'stale-trigger' }),
		},
		status: 'success',
	})

	const stale = await getRunRecord({ env, userId, runId: 'stale-running' })
	expect(stale?.run.status).toBe('error')
	expect(stale?.run.errorName).toBe('Interrupted')
	expect(stale?.run.errorMessage).toMatch(/outcome unknown/i)
	expect(stale?.run.finishedAt).toBeTruthy()

	const fresh = await getRunRecord({ env, userId, runId: 'fresh-running' })
	expect(fresh?.run.status).toBe('running')
	expect(fresh?.run.finishedAt).toBeNull()
})

test('clearRunRecords empties the Durable Object', async () => {
	const userId = uniqueUserId('clear')
	const handle = beginRunRecord({
		env,
		userId,
		context: baseContext({
			surface: 'retriever',
			storageId: 'storage-1',
		}),
	})
	await finishRunRecord({
		env,
		handle,
		status: 'success',
		logs: ['keep me'],
	})
	expect((await listRunRecords({ env, userId })).runs).toHaveLength(1)
	await clearRunRecords({ env, userId })
	expect(await listRunRecords({ env, userId })).toEqual({
		runs: [],
		nextCursor: null,
	})
	expect(await getRunRecord({ env, userId, runId: handle!.id })).toBeNull()
})
