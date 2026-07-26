import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import { buildKodyModuleBundle } from '#worker/package-runtime/module-graph.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
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
	type RunSurface,
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

test('sandbox level markers become structured log levels', async () => {
	const userId = uniqueUserId('log-levels')
	const handle = beginRunRecord({
		env,
		userId,
		context: baseContext({ surface: 'job' }),
	})
	await finishRunRecord({
		env,
		handle,
		status: 'error',
		error: new Error('boom'),
		logs: [
			'plain line',
			'[warn] slow upstream',
			'[error] missing items array',
			'[info] retrying',
			'[debug] cursor=42',
		],
	})
	const detail = await getRunRecord({ env, userId, runId: handle!.id })
	expect(detail?.logs.map((entry) => [entry.level, entry.message])).toEqual([
		['log', 'plain line'],
		['warn', 'slow upstream'],
		['error', 'missing items array'],
		['info', 'retrying'],
		['debug', 'cursor=42'],
	])
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

test('cap eviction never deletes in-flight running rows', async () => {
	const userId = uniqueUserId('cap-protect-running')
	const stub = env.RUN_LOG.get(env.RUN_LOG.idFromName(userId))
	const baseMs = Date.now() - 3_600_000
	// Fewer successes than the eventual excess so the old success→running→error
	// order would delete the in-flight row after successes are exhausted.
	const successCount = 2
	const errorCount = runRecordMaxRunsPerUser
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
		insertRunRow(state, {
			id: 'still-running',
			status: 'running',
			startedAt: new Date(baseMs + successCount).toISOString(),
			finishedAt: null,
		})
		for (let index = 0; index < errorCount; index += 1) {
			const startedAt = new Date(
				baseMs + successCount + 1 + index,
			).toISOString()
			insertRunRow(state, {
				id: `error-${index}`,
				status: 'error',
				startedAt,
				finishedAt: startedAt,
			})
		}
	})
	const seeded = successCount + 1 + errorCount
	await armRetentionOnNextFinish(userId, seeded)

	await finishRunRecord({
		env,
		handle: {
			id: 'cap-running-trigger',
			userId,
			startedAt: new Date(baseMs + seeded + 10).toISOString(),
			persistence: 'eager',
			context: baseContext({ surface: 'job', name: 'cap-running-trigger' }),
		},
		status: 'success',
	})

	const running = await getRunRecord({ env, userId, runId: 'still-running' })
	expect(running?.run.status).toBe('running')

	const counts = await runInDurableObject(
		stub,
		async (_instance: RunLog, state) => ({
			successes: state.storage.sql
				.exec<{ n: number }>(
					`SELECT COUNT(*) AS n FROM runs WHERE status = 'success'`,
				)
				.one().n,
			errors: state.storage.sql
				.exec<{ n: number }>(
					`SELECT COUNT(*) AS n FROM runs WHERE status = 'error'`,
				)
				.one().n,
			running: state.storage.sql
				.exec<{ n: number }>(
					`SELECT COUNT(*) AS n FROM runs WHERE status = 'running'`,
				)
				.one().n,
			success0: state.storage.sql
				.exec<{ n: number }>(
					`SELECT COUNT(*) AS n FROM runs WHERE id = 'success-0'`,
				)
				.one().n,
			error0: state.storage.sql
				.exec<{ n: number }>(
					`SELECT COUNT(*) AS n FROM runs WHERE id = 'error-0'`,
				)
				.one().n,
		}),
	)
	// Excess was 4: 3 successes (2 seeded + trigger) then 1 oldest error.
	// The in-flight row is skipped entirely.
	expect(counts.success0).toBe(0)
	expect(counts.successes).toBe(0)
	expect(counts.running).toBe(1)
	expect(counts.error0).toBe(0)
	expect(counts.errors).toBe(errorCount - 1)
})

test('stale running rows become cap-evictable after reconcile', async () => {
	const userId = uniqueUserId('stale-cap-evict')
	const stub = env.RUN_LOG.get(env.RUN_LOG.idFromName(userId))
	const baseMs = Date.now() - 3_600_000
	const staleStartedAt = new Date(
		Date.now() - runRecordStaleRunningTtlMs - 60_000,
	).toISOString()
	const successCount = 2
	const errorCount = runRecordMaxRunsPerUser - 2
	const staleCount = 5
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
		for (let index = 0; index < staleCount; index += 1) {
			insertRunRow(state, {
				id: `stale-${index}`,
				status: 'running',
				startedAt: new Date(Date.parse(staleStartedAt) + index).toISOString(),
				finishedAt: null,
			})
		}
		for (let index = 0; index < errorCount; index += 1) {
			const startedAt = new Date(baseMs + 10_000 + index).toISOString()
			insertRunRow(state, {
				id: `error-${index}`,
				status: 'error',
				startedAt,
				finishedAt: startedAt,
			})
		}
	})
	const seeded = successCount + staleCount + errorCount
	await armRetentionOnNextFinish(userId, seeded)

	await finishRunRecord({
		env,
		handle: {
			id: 'stale-cap-trigger',
			userId,
			startedAt: new Date(baseMs + seeded + 10).toISOString(),
			persistence: 'eager',
			context: baseContext({ surface: 'job', name: 'stale-cap-trigger' }),
		},
		status: 'success',
	})

	// Reconcile demotes stale running → Interrupted errors (oldest started_at),
	// then cap eviction drains successes and those demoted errors before newer
	// seeded errors.
	const stale0 = await getRunRecord({ env, userId, runId: 'stale-0' })
	expect(stale0).toBeNull()
	const remainingRunning = await runInDurableObject(
		stub,
		async (_instance: RunLog, state) =>
			state.storage.sql
				.exec<{ n: number }>(
					`SELECT COUNT(*) AS n FROM runs WHERE status = 'running'`,
				)
				.one().n,
	)
	expect(remainingRunning).toBe(0)
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

test('run recording degrades to a warning instead of failing the observed run', async () => {
	silenceIncidentalRuntimeWarnings()
	const userId = uniqueUserId('never-throws')
	expect(
		beginRunRecord({
			env,
			userId,
			context: baseContext({ surface: 'not-a-surface' as RunSurface }),
		}),
	).toBeNull()

	// `user_activation_milestones` is absent from this suite's D1 schema, so the
	// activation milestone write fans out into a failure the run must survive.
	await finishRunRecord({
		env,
		handle: {
			id: crypto.randomUUID(),
			userId,
			startedAt: new Date().toISOString(),
			persistence: 'eager',
			context: baseContext({
				surface: 'subscription',
				name: 'email.message.received',
				packageId: 'package-1',
			}),
		},
		status: 'success',
	})

	expect(consoleWarn.mock.calls.map(([message]) => message)).toEqual([
		'run-record-begin-failed',
		'activation-run-record-failed',
	])
	const page = await listRunRecords({ env, userId })
	expect(page.runs).toHaveLength(1)
	expect(page.runs[0]?.status).toBe('success')
})

test('fresh finishes arm a far-future retention alarm for the new row', async () => {
	const userId = uniqueUserId('far-alarm')
	const stub = env.RUN_LOG.get(env.RUN_LOG.idFromName(userId))
	const startedAtMs = Date.now()
	await finishRunRecord({
		env,
		handle: {
			id: crypto.randomUUID(),
			userId,
			startedAt: new Date(startedAtMs).toISOString(),
			persistence: 'eager',
			context: baseContext({ surface: 'job', name: 'fresh' }),
		},
		status: 'success',
	})
	const alarmAt = await runInDurableObject(
		stub,
		async (_instance: RunLog, state) => state.storage.getAlarm(),
	)
	expect(alarmAt).toBeTypeOf('number')
	// One-shot at the row's age deadline — not an immediate/hourly wake.
	expect(alarmAt).toBeGreaterThan(
		startedAtMs + runRecordRetentionDays * 24 * 60 * 60 * 1000 - 5_000,
	)
})

test('retention alarm self-terminates when a pass leaves nothing pending', async () => {
	const userId = uniqueUserId('alarm-stop')
	const stub = env.RUN_LOG.get(env.RUN_LOG.idFromName(userId))
	const oldStartedAt = new Date(
		Date.now() - (runRecordRetentionDays + 2) * 24 * 60 * 60 * 1000,
	).toISOString()
	await runInDurableObject(stub, async (instance: RunLog, state) => {
		expect(instance).toBeInstanceOf(RunLog)
		insertRunRow(state, {
			id: 'old-only',
			status: 'success',
			startedAt: oldStartedAt,
			finishedAt: oldStartedAt,
		})
		state.storage.sql.exec(
			`INSERT INTO run_log_meta (key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			'run_count',
			1,
		)
		// Invoke the handler directly; clear any prior schedule so a leftover
		// platform alarm is not mistaken for a re-arm.
		await state.storage.deleteAlarm()
		await instance.alarm()
	})

	const after = await runInDurableObject(
		stub,
		async (_instance: RunLog, state) => ({
			alarmAt: await state.storage.getAlarm(),
			remaining: state.storage.sql
				.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM runs`)
				.one().n,
		}),
	)
	expect(after.remaining).toBe(0)
	expect(after.alarmAt).toBeNull()
})

test('write after idle re-arms alarm and age-prunes without the finish counter', async () => {
	const userId = uniqueUserId('idle-rearm')
	const stub = env.RUN_LOG.get(env.RUN_LOG.idFromName(userId))
	const oldStartedAt = new Date(
		Date.now() - (runRecordRetentionDays + 2) * 24 * 60 * 60 * 1000,
	).toISOString()

	// Drive to self-terminating idle (empty DO, no alarm).
	await runInDurableObject(stub, async (instance: RunLog, state) => {
		insertRunRow(state, {
			id: 'seed-old',
			status: 'success',
			startedAt: oldStartedAt,
			finishedAt: oldStartedAt,
		})
		state.storage.sql.exec(
			`INSERT INTO run_log_meta (key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			'run_count',
			1,
		)
		await state.storage.deleteAlarm()
		await instance.alarm()
	})
	const idle = await runInDurableObject(
		stub,
		async (_instance: RunLog, state) => ({
			alarmAt: await state.storage.getAlarm(),
			remaining: state.storage.sql
				.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM runs`)
				.one().n,
		}),
	)
	expect(idle.remaining).toBe(0)
	expect(idle.alarmAt).toBeNull()

	const runId = 'post-idle-run'
	await finishRunRecord({
		env,
		handle: {
			id: runId,
			userId,
			startedAt: new Date().toISOString(),
			persistence: 'eager',
			context: baseContext({ surface: 'job', name: 'post-idle' }),
		},
		status: 'success',
	})

	const armed = await runInDurableObject(
		stub,
		async (_instance: RunLog, state) => state.storage.getAlarm(),
	)
	expect(armed).toBeTypeOf('number')

	// Age the row past the cutoff without bumping the amortized finish counter.
	const expiredStartedAt = new Date(
		Date.now() - (runRecordRetentionDays + 3) * 24 * 60 * 60 * 1000,
	).toISOString()
	await runInDurableObject(stub, async (instance: RunLog, state) => {
		state.storage.sql.exec(
			`UPDATE runs SET started_at = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
			expiredStartedAt,
			expiredStartedAt,
			expiredStartedAt,
			runId,
		)
		state.storage.sql.exec(
			`INSERT INTO run_log_meta (key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			'finishes_since_retention',
			0,
		)
		await state.storage.deleteAlarm()
		await instance.alarm()
	})

	const pruned = await getRunRecord({ env, userId, runId })
	expect(pruned).toBeNull()
	const afterAlarm = await runInDurableObject(
		stub,
		async (_instance: RunLog, state) => state.storage.getAlarm(),
	)
	expect(afterAlarm).toBeNull()
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

test(
	'logs from a real failing sandbox execution land in RunLog via getRunRecord',
	{ timeout: 60_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const userId = uniqueUserId('sandbox-fail-logs')
		const callerContext = createMcpCallerContext({
			baseUrl: 'https://kody.dev',
			user: {
				userId,
				email: 'sandbox-fail-logs@example.com',
				displayName: 'Sandbox Fail Logs',
			},
		})
		const bundle = await buildKodyModuleBundle({
			env,
			baseUrl: 'https://kody.dev',
			userId,
			sourceFiles: {
				'entry.ts': [
					'export default async function main() {',
					"\tconsole.log('alpha')",
					"\tconsole.warn('heads up')",
					"\tconsole.error('captured error')",
					"\tthrow new Error('sandbox boom')",
					'}',
				].join('\n'),
			},
			entryPoint: 'entry.ts',
		})
		const result = await runBundledModuleWithRegistry(
			env,
			callerContext,
			bundle,
			undefined,
			{
				skipCapabilityRegistry: true,
				runRecord: {
					surface: 'execute',
					name: 'failing-console-logs',
				},
			},
		)
		expect(result.error).toBe('sandbox boom')
		expect(result.logs).toEqual([
			'alpha',
			'[warn] heads up',
			'[error] captured error',
		])

		const page = await listRunRecords({
			env,
			userId,
			filter: { surface: 'execute', name: 'failing-console-logs' },
		})
		expect(page.runs).toHaveLength(1)
		expect(page.runs[0]?.status).toBe('error')
		expect(page.runs[0]?.errorMessage).toBe('sandbox boom')

		const detail = await getRunRecord({
			env,
			userId,
			runId: page.runs[0]!.id,
		})
		expect(detail).not.toBeNull()
		// The sandbox flattens console output to strings with a level marker;
		// persistence recovers the structured level so readers can filter and
		// colour by it rather than pattern-matching message text.
		expect(detail?.logs.map((entry) => [entry.level, entry.message])).toEqual([
			['log', 'alpha'],
			['warn', 'heads up'],
			['error', 'captured error'],
		])
	},
)
