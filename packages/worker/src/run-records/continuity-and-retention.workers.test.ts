import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { RunLog } from './run-log-do.ts'
import {
	finishRunRecord,
	beginRunRecord,
	getJobRunObservability,
	getWorkflowProjection,
	listActivationMilestones,
	listPackageRunSuccesses,
	upsertWorkflowProjection,
} from './service.ts'
import {
	runRecordRetentionEveryNFinishes,
	workflowProjectionRetentionDays,
} from './types.ts'

function uniqueUserId(label: string) {
	return `runlog-continuity-${label}-${crypto.randomUUID()}`
}

function silenceExpectedConsoleWarns(substrings: Array<string>) {
	silenceIncidentalRuntimeWarnings()
	consoleWarn.mockImplementation((...args: Array<unknown>) => {
		const message = String(args[0] ?? '')
		if (substrings.some((part) => message.includes(part))) return
	})
}

async function armRetentionOnNextFinish(userId: string) {
	const stub = env.RUN_LOG.get(env.RUN_LOG.idFromName(userId))
	await runInDurableObject(stub, async (instance: RunLog, state) => {
		expect(instance).toBeInstanceOf(RunLog)
		state.storage.sql.exec(
			`INSERT INTO run_log_meta (key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			'finishes_since_retention',
			runRecordRetentionEveryNFinishes - 1,
		)
	})
}

test('activation milestones accumulate from zero across terminal finishes', async () => {
	silenceExpectedConsoleWarns(['activation-run-record-failed'])
	const userId = uniqueUserId('activation-from-zero')

	const first = beginRunRecord({
		env,
		userId,
		context: {
			surface: 'job',
			name: 'first-success',
			packageId: 'pkg-seed',
		},
	})
	await finishRunRecord({ env, handle: first, status: 'success' })
	expect(await listPackageRunSuccesses({ env, userId })).toEqual([
		expect.objectContaining({ packageId: 'pkg-seed', successCount: 1 }),
	])
	expect(await listActivationMilestones({ env, userId })).toEqual([
		expect.objectContaining({
			milestone: 'package_run_succeeded',
			packageId: 'pkg-seed',
		}),
	])

	const second = beginRunRecord({
		env,
		userId,
		context: {
			surface: 'job',
			name: 'second-success',
			packageId: 'pkg-seed',
		},
	})
	await finishRunRecord({ env, handle: second, status: 'success' })
	expect(await listPackageRunSuccesses({ env, userId })).toEqual([
		expect.objectContaining({ packageId: 'pkg-seed', successCount: 2 }),
	])
	expect(await listActivationMilestones({ env, userId })).toEqual([
		expect.objectContaining({
			milestone: 'package_activated',
			packageId: 'pkg-seed',
		}),
		expect.objectContaining({
			milestone: 'package_run_succeeded',
			packageId: 'pkg-seed',
		}),
	])
})

test('job observability counters start from zero on first terminal finish', async () => {
	silenceExpectedConsoleWarns(['activation-run-record-failed'])
	const userId = uniqueUserId('job-from-zero')
	const jobId = `job-${crypto.randomUUID()}`

	const handle = beginRunRecord({
		env,
		userId,
		context: { surface: 'job', name: 'first', jobId },
	})
	await finishRunRecord({
		env,
		handle,
		status: 'error',
		error: new Error('new failure'),
	})
	expect(await getJobRunObservability({ env, userId, jobId })).toMatchObject({
		jobId,
		runCount: 1,
		successCount: 0,
		errorCount: 1,
		lastRunStatus: 'error',
		lastRunError: 'new failure',
	})
	expect(
		await getJobRunObservability({ env, userId, jobId }),
	).not.toHaveProperty('legacySeeded')

	const second = beginRunRecord({
		env,
		userId,
		context: { surface: 'job', name: 'second', jobId },
	})
	await finishRunRecord({ env, handle: second, status: 'success' })
	expect(await getJobRunObservability({ env, userId, jobId })).toMatchObject({
		runCount: 2,
		successCount: 1,
		errorCount: 1,
		lastRunStatus: 'success',
	})
})

test('finishRun rolls back run upsert when a later terminal side effect throws', async () => {
	const userId = uniqueUserId('finish-tx')
	const stub = env.RUN_LOG.get(env.RUN_LOG.idFromName(userId))
	const runId = crypto.randomUUID()
	await runInDurableObject(stub, async (instance: RunLog, state) => {
		expect(instance).toBeInstanceOf(RunLog)
		const proto = Object.getPrototypeOf(instance) as {
			recordTerminalRunSideEffects: (input: unknown) => void
		}
		const original = proto.recordTerminalRunSideEffects
		proto.recordTerminalRunSideEffects = () => {
			throw new Error('forced-finish-rollback')
		}
		try {
			await expect(
				instance.finishRun({
					run: {
						id: runId,
						surface: 'job',
						status: 'success',
						name: 'tx-fail',
						packageId: 'pkg-finish-tx',
						kodyId: null,
						sourceId: null,
						publishedCommit: null,
						storageId: null,
						jobId: 'job-finish-tx',
						workflowId: null,
						invocationId: null,
						sessionId: null,
						idempotencyKey: null,
						parentRunId: null,
						startedAt: '2026-07-31T00:00:00.000Z',
						finishedAt: '2026-07-31T00:00:01.000Z',
						durationMs: 1000,
						errorName: null,
						errorMessage: null,
						metadataJson: '{}',
						createdAt: '2026-07-31T00:00:00.000Z',
						updatedAt: '2026-07-31T00:00:01.000Z',
					},
					logs: [],
				}),
			).rejects.toThrow('forced-finish-rollback')
		} finally {
			proto.recordTerminalRunSideEffects = original
		}
		const runs = state.storage.sql
			.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM runs WHERE id = ?`, runId)
			.one()
		const successes = state.storage.sql
			.exec<{ n: number }>(
				`SELECT COUNT(*) AS n FROM package_run_successes WHERE package_id = 'pkg-finish-tx'`,
			)
			.one()
		const jobs = state.storage.sql
			.exec<{ n: number }>(
				`SELECT COUNT(*) AS n FROM job_run_observability WHERE job_id = 'job-finish-tx'`,
			)
			.one()
		expect(Number(runs.n)).toBe(0)
		expect(Number(successes.n)).toBe(0)
		expect(Number(jobs.n)).toBe(0)
	})

	silenceExpectedConsoleWarns(['activation-run-record-failed'])
	await finishRunRecord({
		env,
		handle: beginRunRecord({
			env,
			userId,
			context: {
				surface: 'job',
				name: 'tx-ok',
				packageId: 'pkg-tx-ok',
			},
		}),
		status: 'success',
	})
	expect(await listPackageRunSuccesses({ env, userId })).toEqual([
		expect.objectContaining({ packageId: 'pkg-tx-ok', successCount: 1 }),
	])
	expect(await listActivationMilestones({ env, userId })).toEqual([
		expect.objectContaining({
			milestone: 'package_run_succeeded',
			packageId: 'pkg-tx-ok',
		}),
	])
})

test('workflow projection retention prunes old terminal rows but keeps active and unpruned dedicated state', async () => {
	silenceExpectedConsoleWarns(['activation-run-record-failed'])
	const userId = uniqueUserId('wf-retention')
	const oldTerminalAt = new Date(
		Date.now() - (workflowProjectionRetentionDays + 5) * 24 * 60 * 60 * 1000,
	).toISOString()
	const oldActiveAt = new Date(
		Date.now() - (workflowProjectionRetentionDays + 10) * 24 * 60 * 60 * 1000,
	).toISOString()

	await upsertWorkflowProjection({
		env,
		userId,
		projection: {
			id: 'wf-old-terminal',
			bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
			sourceType: 'inline',
			workflowName: 'done',
			idempotencyKey: 'idem-old-terminal',
			runAt: oldTerminalAt,
			status: 'complete',
			createdAt: oldTerminalAt,
			updatedAt: oldTerminalAt,
			completedAt: oldTerminalAt,
		},
	})
	await upsertWorkflowProjection({
		env,
		userId,
		projection: {
			id: 'wf-old-active',
			bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
			sourceType: 'inline',
			workflowName: 'still-running',
			idempotencyKey: 'idem-old-active',
			runAt: oldActiveAt,
			status: 'running',
			createdAt: oldActiveAt,
			updatedAt: oldActiveAt,
		},
	})
	await upsertWorkflowProjection({
		env,
		userId,
		projection: {
			id: 'wf-old-creating',
			bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
			sourceType: 'package',
			packageId: 'pkg-keep',
			workflowName: 'creating',
			exportName: 'run',
			idempotencyKey: 'idem-old-creating',
			runAt: oldActiveAt,
			status: 'creating',
			createdAt: oldActiveAt,
			updatedAt: oldActiveAt,
		},
	})

	await finishRunRecord({
		env,
		handle: beginRunRecord({
			env,
			userId,
			context: {
				surface: 'job',
				name: 'keep-stats',
				jobId: 'job-keep-stats',
				packageId: 'pkg-keep-stats',
			},
		}),
		status: 'success',
	})

	await armRetentionOnNextFinish(userId)
	await finishRunRecord({
		env,
		handle: beginRunRecord({
			env,
			userId,
			context: {
				surface: 'job',
				name: 'trigger-retention',
				packageId: 'pkg-keep-stats',
			},
		}),
		status: 'success',
	})

	expect(
		await getWorkflowProjection({ env, userId, id: 'wf-old-terminal' }),
	).toBeNull()
	expect(
		await getWorkflowProjection({ env, userId, id: 'wf-old-active' }),
	).toMatchObject({ id: 'wf-old-active', status: 'running' })
	expect(
		await getWorkflowProjection({ env, userId, id: 'wf-old-creating' }),
	).toBeNull()

	expect(await listPackageRunSuccesses({ env, userId })).toEqual([
		expect.objectContaining({
			packageId: 'pkg-keep-stats',
			successCount: 2,
		}),
	])
	expect(
		await listActivationMilestones({ env, userId }).then((rows) => rows.length),
	).toBeGreaterThan(0)
	expect(
		await getJobRunObservability({ env, userId, jobId: 'job-keep-stats' }),
	).toMatchObject({ jobId: 'job-keep-stats', successCount: 1 })
})

test('missing APP_DB does not affect terminal job/activation updates', async () => {
	silenceExpectedConsoleWarns(['activation-run-record-failed'])
	const userId = uniqueUserId('no-app-db')
	const envWithoutDb = { ...env, APP_DB: undefined } as unknown as Env
	await finishRunRecord({
		env: envWithoutDb,
		handle: beginRunRecord({
			env: envWithoutDb,
			userId,
			context: {
				surface: 'job',
				name: 'degrade',
				jobId: 'missing-job',
				packageId: 'pkg-degrade',
			},
		}),
		status: 'success',
	})
	expect(await listPackageRunSuccesses({ env, userId })).toEqual([
		expect.objectContaining({ packageId: 'pkg-degrade', successCount: 1 }),
	])
	expect(
		await getJobRunObservability({ env, userId, jobId: 'missing-job' }),
	).toMatchObject({
		jobId: 'missing-job',
		runCount: 1,
		successCount: 1,
	})
})
