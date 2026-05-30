import { expect, test } from 'vitest'
import { processDueJobs } from './process-due-jobs.ts'
import { type JobRecord } from './types.ts'

function createCronJob(overrides: Partial<JobRecord> = {}): JobRecord {
	return {
		version: 1,
		id: 'job-1',
		userId: 'user-1',
		name: 'Morning job',
		code: 'export default async () => ({ ok: true })',
		storageId: 'job:job-1',
		schedule: {
			type: 'cron',
			expression: '0 7 * * *',
		},
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		createdAt: '2026-04-12T00:00:00.000Z',
		updatedAt: '2026-04-12T00:00:00.000Z',
		nextRunAt: '2026-04-12T07:00:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
		runHistory: [],
		...overrides,
	}
}

test('processDueJobs handles cron batching and once-job delete, preserve, and reschedule outcomes', async () => {
	const now = new Date('2026-04-12T07:00:00.000Z')
	const first = createCronJob({ id: 'job-1' })
	const second = createCronJob({ id: 'job-2', name: 'Second job' })

	const batchResult = await processDueJobs({
		jobs: [first, second],
		now,
		async executeJob(job) {
			if (job.id === 'job-1') {
				throw new Error('boom')
			}
			return {
				execution: {
					ok: true,
					logs: ['ok'],
					result: { ok: true },
				},
				startedAt: now.toISOString(),
				finishedAt: now.toISOString(),
				durationMs: 0,
			}
		},
	})

	expect(batchResult.deleteJobIds).toEqual([])
	expect(batchResult.saveJobs).toHaveLength(2)
	expect(batchResult.successCount).toBe(1)
	expect(batchResult.errorCount).toBe(1)
	expect(batchResult.jobOutcomes).toEqual([
		{
			jobId: 'job-1',
			scheduleType: 'cron',
			outcome: 'failure',
			nextRunAt: expect.any(String),
			deleted: false,
			error: 'boom',
		},
		{
			jobId: 'job-2',
			scheduleType: 'cron',
			outcome: 'success',
			nextRunAt: expect.any(String),
			deleted: false,
		},
	])
	expect(batchResult.saveJobs).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				id: 'job-1',
				lastRunStatus: 'error',
				lastRunError: 'boom',
				lastRunAt: now.toISOString(),
				runCount: 1,
				successCount: 0,
				errorCount: 1,
			}),
			expect.objectContaining({
				id: 'job-2',
				lastRunStatus: 'success',
				lastRunAt: now.toISOString(),
				runCount: 1,
				successCount: 1,
				errorCount: 0,
			}),
		]),
	)

	const failedOnceJob = createCronJob({
		id: 'job-once',
		schedule: {
			type: 'once',
			runAt: '2026-04-12T07:00:00.000Z',
		},
		nextRunAt: '2026-04-12T07:00:00.000Z',
	})
	const failedOnceResult = await processDueJobs({
		jobs: [failedOnceJob],
		now,
		async executeJob() {
			return {
				execution: {
					ok: false,
					error: 'expected failure',
					logs: [],
				},
				startedAt: '2026-04-12T07:00:00.000Z',
				finishedAt: '2026-04-12T07:00:00.000Z',
				durationMs: 0,
			}
		},
	})
	expect(failedOnceResult.deleteJobIds).toEqual([])
	expect(failedOnceResult.saveJobs).toEqual([
		expect.objectContaining({
			id: 'job-once',
			enabled: false,
			lastRunStatus: 'error',
			lastRunError: 'expected failure',
			runCount: 1,
			successCount: 0,
			errorCount: 1,
		}),
	])
	expect(failedOnceResult.jobOutcomes).toEqual([
		{
			jobId: 'job-once',
			scheduleType: 'once',
			outcome: 'failure',
			nextRunAt: '2026-04-12T07:00:00.000Z',
			deleted: false,
			error: 'expected failure',
		},
	])

	const successOnceJob = createCronJob({
		id: 'job-once-success',
		schedule: {
			type: 'once',
			runAt: '2026-04-12T07:00:00.000Z',
		},
		nextRunAt: '2026-04-12T07:00:00.000Z',
	})
	const successOnceResult = await processDueJobs({
		jobs: [successOnceJob],
		now,
		async executeJob() {
			return {
				execution: {
					ok: true,
					logs: ['ok'],
					result: { ok: true },
				},
				startedAt: '2026-04-12T07:00:00.000Z',
				finishedAt: '2026-04-12T07:00:00.000Z',
				durationMs: 0,
			}
		},
	})
	expect(successOnceResult.deleteJobIds).toEqual(['job-once-success'])
	expect(successOnceResult.saveJobs).toEqual([])
	expect(successOnceResult.jobOutcomes).toEqual([
		{
			jobId: 'job-once-success',
			scheduleType: 'once',
			outcome: 'success',
			nextRunAt: null,
			deleted: true,
		},
	])

	const cronJob = createCronJob({
		id: 'job-reschedule-failure',
		schedule: {
			type: 'cron',
			expression: '* *',
		},
		nextRunAt: '2026-04-12T07:00:00.000Z',
	})
	const rescheduleFailureResult = await processDueJobs({
		jobs: [cronJob],
		now,
		async executeJob() {
			return {
				execution: {
					ok: true,
					logs: ['ok'],
					result: { ok: true },
				},
				startedAt: '2026-04-12T07:00:00.000Z',
				finishedAt: '2026-04-12T07:00:00.000Z',
				durationMs: 0,
			}
		},
	})
	expect(rescheduleFailureResult.saveJobs).toHaveLength(1)
	expect(rescheduleFailureResult.successCount).toBe(0)
	expect(rescheduleFailureResult.errorCount).toBe(1)
	expect(rescheduleFailureResult.jobOutcomes).toEqual([
		{
			jobId: 'job-reschedule-failure',
			scheduleType: 'cron',
			outcome: 'failure',
			nextRunAt: '2026-04-12T07:00:00.000Z',
			deleted: false,
			error:
				'Cron expressions must use standard 5-field syntax: minute hour day-of-month month day-of-week.',
			rescheduleError:
				'Cron expressions must use standard 5-field syntax: minute hour day-of-month month day-of-week.',
		},
	])
	expect(rescheduleFailureResult.saveJobs[0]).toEqual(
		expect.objectContaining({
			id: 'job-reschedule-failure',
			enabled: false,
			lastRunStatus: 'error',
			lastRunError:
				'Failed to reschedule job: Cron expressions must use standard 5-field syntax: minute hour day-of-month month day-of-week.',
		}),
	)
})
