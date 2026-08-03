import { expect, test, vi } from 'vitest'
import {
	buildScheduledJobIdempotencyKey,
	computeJobRetryAt,
	executeOrReplayScheduledJobRun,
	isTransientJobExecutionError,
	markPreExecutionTransientError,
	resolveScheduledJobCallerContext,
	TransientJobExecutionError,
} from './execution-safety.ts'
import { processDueJobs } from './process-due-jobs.ts'
import { type JobRecord, type PersistedJobCallerContext } from './types.ts'

function createJob(schedule: JobRecord['schedule']): JobRecord {
	return {
		version: 1,
		id: 'job-1',
		userId: 'user-1',
		name: 'Safe job',
		sourceId: 'source-1',
		publishedCommit: null,
		storageId: 'job:job-1',
		schedule,
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		preserved: false,
		expiresAt: null,
		createdAt: '2026-07-29T12:00:00.000Z',
		updatedAt: '2026-07-29T12:00:00.000Z',
		nextRunAt: '2026-07-29T12:00:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
	}
}

test('terminal scheduled run replay returns retained result without executing', async () => {
	const execute = vi.fn()
	const scheduledFor = '2026-07-29T12:00:00.000Z'
	const outcome = await executeOrReplayScheduledJobRun({
		claim: {
			claimed: false,
			run: {
				id: 'run-1',
				surface: 'job',
				status: 'success',
				name: 'Safe job',
				packageId: null,
				kodyId: null,
				sourceId: 'source-1',
				publishedCommit: null,
				storageId: 'job:job-1',
				jobId: 'job-1',
				workflowId: null,
				invocationId: null,
				sessionId: null,
				idempotencyKey: buildScheduledJobIdempotencyKey({
					jobId: 'job-1',
					scheduledFor,
				}),
				parentRunId: null,
				startedAt: scheduledFor,
				finishedAt: '2026-07-29T12:00:01.000Z',
				durationMs: 1_000,
				errorName: null,
				errorMessage: null,
				metadata: {
					scheduledFor,
					result: { retained: true },
				},
				logCount: 0,
			},
		},
		execute,
	})

	expect(execute).not.toHaveBeenCalled()
	expect(outcome).toEqual({
		execution: {
			ok: true,
			result: { retained: true },
			logs: [],
		},
		startedAt: scheduledFor,
		finishedAt: '2026-07-29T12:00:01.000Z',
		durationMs: 1_000,
	})

	await expect(
		executeOrReplayScheduledJobRun({
			claim: null,
			execute,
		}),
	).rejects.toThrow(
		'Unable to claim scheduled job idempotency key; RUN_LOG is unavailable.',
	)
	expect(execute).not.toHaveBeenCalled()
})

test('running scheduled run backs off without duplicate execution', async () => {
	const execute = vi.fn()
	const scheduledFor = '2026-07-29T12:00:00.000Z'
	await expect(
		executeOrReplayScheduledJobRun({
			claim: {
				claimed: false,
				run: {
					id: 'run-running',
					surface: 'job',
					status: 'running',
					name: 'Safe job',
					packageId: null,
					kodyId: null,
					sourceId: 'source-1',
					publishedCommit: null,
					storageId: 'job:job-1',
					jobId: 'job-1',
					workflowId: null,
					invocationId: null,
					sessionId: null,
					idempotencyKey: buildScheduledJobIdempotencyKey({
						jobId: 'job-1',
						scheduledFor,
					}),
					parentRunId: null,
					startedAt: scheduledFor,
					finishedAt: null,
					durationMs: null,
					errorName: null,
					errorMessage: null,
					metadata: { scheduledFor },
					logCount: 0,
				},
			},
			execute,
		}),
	).rejects.toBeInstanceOf(TransientJobExecutionError)
	expect(execute).not.toHaveBeenCalled()
})

test('scheduled caller context must belong to the jobs row user', () => {
	const callerContext = {
		user: { userId: 'user-1' },
	} as PersistedJobCallerContext
	expect(
		resolveScheduledJobCallerContext({
			rowUserId: 'user-1',
			callerContext,
		}),
	).toBe(callerContext)
	expect(
		resolveScheduledJobCallerContext({
			rowUserId: 'user-2',
			callerContext,
		}),
	).toBeNull()
})

test('transient platform failures back off the same occurrence while permanent once failures complete it', async () => {
	const now = new Date('2026-07-29T12:00:00.000Z')
	expect(
		isTransientJobExecutionError(
			new Error('D1_ERROR: Network connection lost.'),
		),
	).toBe(true)
	expect(
		isTransientJobExecutionError(
			new Error(
				"Durable Object's isolate exceeded its memory limit and was reset.",
			),
		),
	).toBe(true)
	expect(
		isTransientJobExecutionError(
			new Error(
				'Internal error in Durable Object storage caused object to be reset; reference = 849rqmf61lg3qbmtb3j6moc4',
			),
		),
	).toBe(true)
	expect(isTransientJobExecutionError(new Error('user code failed'))).toBe(
		false,
	)
	expect(
		markPreExecutionTransientError(
			new Error('D1_ERROR: Network connection lost.'),
		),
	).toBeInstanceOf(TransientJobExecutionError)
	expect(
		markPreExecutionTransientError(new Error('user code failed')),
	).not.toBeInstanceOf(TransientJobExecutionError)
	expect(computeJobRetryAt({ now, retryCount: 0 })).toBe(
		'2026-07-29T12:00:05.000Z',
	)
	expect(computeJobRetryAt({ now, retryCount: 3 })).toBe(
		'2026-07-29T12:00:40.000Z',
	)

	const once = createJob({
		type: 'once',
		runAt: now.toISOString(),
	})
	const permanent = await processDueJobs({
		jobs: [once],
		now,
		async executeJob() {
			return {
				execution: {
					ok: false,
					error: 'user code failed',
					logs: [],
				},
				startedAt: now.toISOString(),
				finishedAt: now.toISOString(),
				durationMs: 0,
			}
		},
	})
	expect(permanent.saveJobs[0]).toMatchObject({
		enabled: false,
		lastRunStatus: 'error',
		lastRunAt: expect.any(String),
		// RunLog owns counters/error; scheduling finalization keeps D1 copies.
		runCount: 0,
		errorCount: 0,
	})
})
