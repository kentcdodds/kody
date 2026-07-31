import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { RunLog } from './run-log-do.ts'
import {
	ensureActivationStateSeeded,
	ensureJobRunObservabilitySeeded,
	finishRunRecord,
	beginRunRecord,
	getJobRunObservability,
	getWorkflowProjection,
	listActivationMilestones,
	listPackageRunSuccesses,
	runLogRpc,
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

async function ensureActivationD1Schema() {
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS user_package_run_successes (
			user_id TEXT NOT NULL,
			package_id TEXT NOT NULL,
			success_count INTEGER NOT NULL CHECK (success_count >= 0),
			updated_at TEXT NOT NULL,
			PRIMARY KEY (user_id, package_id)
		)`,
	).run()
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS user_activation_milestones (
			user_id TEXT NOT NULL,
			milestone TEXT NOT NULL CHECK (
				milestone IN ('package_run_succeeded', 'package_activated')
			),
			reached_at TEXT NOT NULL,
			package_id TEXT,
			PRIMARY KEY (user_id, milestone)
		)`,
	).run()
}

async function ensureJobsD1Schema() {
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS jobs (
			id TEXT PRIMARY KEY NOT NULL,
			user_id TEXT NOT NULL,
			name TEXT NOT NULL,
			source_id TEXT NOT NULL DEFAULT '',
			storage_id TEXT NOT NULL DEFAULT '',
			schedule_json TEXT NOT NULL DEFAULT '{}',
			timezone TEXT NOT NULL DEFAULT 'UTC',
			enabled INTEGER NOT NULL DEFAULT 1,
			kill_switch_enabled INTEGER NOT NULL DEFAULT 0,
			caller_context_json TEXT NOT NULL DEFAULT 'null',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			last_run_at TEXT,
			last_run_status TEXT,
			last_run_error TEXT,
			last_duration_ms INTEGER,
			next_run_at TEXT NOT NULL DEFAULT '',
			run_count INTEGER NOT NULL DEFAULT 0,
			success_count INTEGER NOT NULL DEFAULT 0,
			error_count INTEGER NOT NULL DEFAULT 0
		)`,
	).run()
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

test('D1 activation success_count=1 seeds once and next same-package success activates', async () => {
	silenceExpectedConsoleWarns([
		'activation-run-record-failed',
		'run-log-activation-seed-failed',
	])
	await ensureActivationD1Schema()
	const userId = uniqueUserId('activation-seed')
	const reachedAt = '2026-01-15T00:00:00.000Z'
	await env.APP_DB.prepare(
		`DELETE FROM user_package_run_successes WHERE user_id = ?`,
	)
		.bind(userId)
		.run()
	await env.APP_DB.prepare(
		`DELETE FROM user_activation_milestones WHERE user_id = ?`,
	)
		.bind(userId)
		.run()
	await env.APP_DB.prepare(
		`INSERT INTO user_package_run_successes (user_id, package_id, success_count, updated_at)
		VALUES (?, 'pkg-seed', 1, ?)`,
	)
		.bind(userId, reachedAt)
		.run()
	await env.APP_DB.prepare(
		`INSERT INTO user_activation_milestones (user_id, milestone, reached_at, package_id)
		VALUES (?, 'package_run_succeeded', ?, 'pkg-seed')`,
	)
		.bind(userId, reachedAt)
		.run()

	await ensureActivationStateSeeded({ env, userId })
	expect(await listPackageRunSuccesses({ env, userId })).toEqual([
		expect.objectContaining({ packageId: 'pkg-seed', successCount: 1 }),
	])
	expect(await listActivationMilestones({ env, userId })).toEqual([
		expect.objectContaining({
			milestone: 'package_run_succeeded',
			reachedAt,
			packageId: 'pkg-seed',
		}),
	])

	// Repeated initialization cannot regress counts or overwrite reachedAt.
	await runLogRpc({ env, userId }).importActivationState({
		packageRunSuccesses: [
			{
				packageId: 'pkg-seed',
				successCount: 0,
				updatedAt: '2026-07-01T00:00:00.000Z',
			},
		],
		milestones: [
			{
				milestone: 'package_run_succeeded',
				reachedAt: '2026-07-01T00:00:00.000Z',
				packageId: 'pkg-other',
			},
		],
	})
	expect(await listPackageRunSuccesses({ env, userId })).toEqual([
		expect.objectContaining({ packageId: 'pkg-seed', successCount: 1 }),
	])
	expect(await listActivationMilestones({ env, userId })).toEqual([
		expect.objectContaining({
			milestone: 'package_run_succeeded',
			reachedAt,
			packageId: 'pkg-seed',
		}),
	])

	const handle = beginRunRecord({
		env,
		userId,
		context: {
			surface: 'job',
			name: 'second-success',
			packageId: 'pkg-seed',
		},
	})
	await finishRunRecord({ env, handle, status: 'success' })
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
			reachedAt,
			packageId: 'pkg-seed',
		}),
	])

	// Marker stops further D1 reads: wiping D1 must not clear DO state on seed.
	await env.APP_DB.prepare(
		`DELETE FROM user_package_run_successes WHERE user_id = ?`,
	)
		.bind(userId)
		.run()
	await ensureActivationStateSeeded({ env, userId })
	expect(await listPackageRunSuccesses({ env, userId })).toEqual([
		expect.objectContaining({ packageId: 'pkg-seed', successCount: 2 }),
	])
})

test('first post-cutover job finish preserves cumulative D1 counters', async () => {
	silenceExpectedConsoleWarns([
		'activation-run-record-failed',
		'run-log-job-observability-seed-failed',
	])
	await ensureJobsD1Schema()
	const userId = uniqueUserId('job-seed')
	const jobId = `job-${crypto.randomUUID()}`
	const now = '2026-07-01T00:00:00.000Z'
	await env.APP_DB.prepare(`DELETE FROM jobs WHERE id = ?`).bind(jobId).run()
	await env.APP_DB.prepare(
		`INSERT INTO jobs (
			id, user_id, name, created_at, updated_at, last_run_at, last_run_status,
			last_run_error, last_duration_ms, run_count, success_count, error_count
		) VALUES (?, ?, 'seeded', ?, ?, ?, 'success', NULL, 12, 5, 4, 1)`,
	)
		.bind(jobId, userId, now, now, now)
		.run()

	await ensureJobRunObservabilitySeeded({ env, userId, jobId })
	expect(await getJobRunObservability({ env, userId, jobId })).toMatchObject({
		jobId,
		runCount: 5,
		successCount: 4,
		errorCount: 1,
		lastRunStatus: 'success',
	})

	// INSERT OR IGNORE: a newer DO outcome cannot be overwritten by re-seed.
	await runLogRpc({ env, userId }).seedJobRunObservabilityIfAbsent({
		jobId,
		lastRunAt: '2020-01-01T00:00:00.000Z',
		lastRunStatus: 'error',
		lastRunError: 'stale',
		lastDurationMs: 1,
		runCount: 1,
		successCount: 0,
		errorCount: 1,
		updatedAt: '2020-01-01T00:00:00.000Z',
	})
	expect(await getJobRunObservability({ env, userId, jobId })).toMatchObject({
		runCount: 5,
		successCount: 4,
		lastRunStatus: 'success',
	})

	const handle = beginRunRecord({
		env,
		userId,
		context: { surface: 'job', name: 'post-cutover', jobId },
	})
	await finishRunRecord({
		env,
		handle,
		status: 'error',
		error: new Error('new failure'),
	})
	expect(await getJobRunObservability({ env, userId, jobId })).toMatchObject({
		runCount: 6,
		successCount: 4,
		errorCount: 2,
		lastRunStatus: 'error',
		lastRunError: 'new failure',
	})
})

test('activation increment uses a storage transaction that rolls back on throw', async () => {
	const userId = uniqueUserId('activation-tx')
	const stub = env.RUN_LOG.get(env.RUN_LOG.idFromName(userId))
	await runInDurableObject(stub, async (instance: RunLog, state) => {
		expect(instance).toBeInstanceOf(RunLog)
		try {
			state.storage.transactionSync(() => {
				state.storage.sql.exec(
					`INSERT INTO package_run_successes (package_id, success_count, updated_at)
					VALUES ('pkg-tx', 1, '2026-07-31T00:00:00.000Z')`,
				)
				state.storage.sql.exec(
					`INSERT INTO activation_milestones (milestone, reached_at, package_id)
					VALUES ('package_run_succeeded', '2026-07-31T00:00:00.000Z', 'pkg-tx')`,
				)
				throw new Error('forced-activation-rollback')
			})
		} catch (error) {
			expect(String(error)).toContain('forced-activation-rollback')
		}
		const successes = state.storage.sql
			.exec<{ n: number }>(
				`SELECT COUNT(*) AS n FROM package_run_successes WHERE package_id = 'pkg-tx'`,
			)
			.one()
		const milestones = state.storage.sql
			.exec<{ n: number }>(
				`SELECT COUNT(*) AS n FROM activation_milestones WHERE package_id = 'pkg-tx'`,
			)
			.one()
		expect(Number(successes.n)).toBe(0)
		expect(Number(milestones.n)).toBe(0)
	})

	// Happy path still lands count + milestone together via finish.
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
	).toMatchObject({ id: 'wf-old-creating', status: 'creating' })

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

test('missing APP_DB activation/job seed degrades without failing finish', async () => {
	silenceExpectedConsoleWarns([
		'run-log-activation-seed-failed',
		'run-log-job-observability-seed-failed',
		'activation-run-record-failed',
	])
	const userId = uniqueUserId('seed-degrade')
	const envWithoutDb = { ...env, APP_DB: undefined } as unknown as Env
	await expect(
		ensureActivationStateSeeded({ env: envWithoutDb, userId }),
	).resolves.toBeUndefined()
	await expect(
		ensureJobRunObservabilitySeeded({
			env: envWithoutDb,
			userId,
			jobId: 'missing-job',
		}),
	).resolves.toBeUndefined()
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
	// Without APP_DB the finish still wrote DO activation from a zero baseline.
	expect(await listPackageRunSuccesses({ env, userId })).toEqual([
		expect.objectContaining({ packageId: 'pkg-degrade', successCount: 1 }),
	])
})
