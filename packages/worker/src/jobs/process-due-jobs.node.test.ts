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

test('processDueJobs records failures without aborting later jobs', async () => {
	const now = new Date('2026-04-12T07:00:00.000Z')
	const first = createCronJob({ id: 'job-1' })
	const second = createCronJob({ id: 'job-2', name: 'Second job' })

	const result = await processDueJobs({
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

	expect(result.deleteJobIds).toEqual([])
	expect(result.saveJobs).toHaveLength(2)
	expect(result.successCount).toBe(1)
	expect(result.errorCount).toBe(1)
	expect(result.jobOutcomes).toEqual([
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
	expect(result.saveJobs).toEqual(
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
})

test('processDueJobs preserves failed one-shot jobs for inspection', async () => {
	const onceJob = createCronJob({
		id: 'job-once',
		schedule: {
			type: 'once',
			runAt: '2026-04-12T07:00:00.000Z',
		},
		nextRunAt: '2026-04-12T07:00:00.000Z',
	})

	const result = await processDueJobs({
		jobs: [onceJob],
		now: new Date('2026-04-12T07:00:00.000Z'),
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

	expect(result.deleteJobIds).toEqual([])
	expect(result.saveJobs).toEqual([
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
	expect(result.successCount).toBe(0)
	expect(result.errorCount).toBe(1)
	expect(result.jobOutcomes).toEqual([
		{
			jobId: 'job-once',
			scheduleType: 'once',
			outcome: 'failure',
			nextRunAt: '2026-04-12T07:00:00.000Z',
			deleted: false,
			error: 'expected failure',
		},
	])
})

test('processDueJobs deletes successful one-shot jobs', async () => {
	const onceJob = createCronJob({
		id: 'job-once-success',
		schedule: {
			type: 'once',
			runAt: '2026-04-12T07:00:00.000Z',
		},
		nextRunAt: '2026-04-12T07:00:00.000Z',
	})

	const result = await processDueJobs({
		jobs: [onceJob],
		now: new Date('2026-04-12T07:00:00.000Z'),
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

	expect(result.deleteJobIds).toEqual(['job-once-success'])
	expect(result.saveJobs).toEqual([])
	expect(result.successCount).toBe(1)
	expect(result.errorCount).toBe(0)
	expect(result.jobOutcomes).toEqual([
		{
			jobId: 'job-once-success',
			scheduleType: 'once',
			outcome: 'success',
			nextRunAt: null,
			deleted: true,
		},
	])
})

test('processDueJobs treats reschedule failures as failed outcomes', async () => {
	const cronJob = createCronJob({
		id: 'job-reschedule-failure',
		schedule: {
			type: 'cron',
			expression: '* *',
		},
		nextRunAt: '2026-04-12T07:00:00.000Z',
	})

	const result = await processDueJobs({
		jobs: [cronJob],
		now: new Date('2026-04-12T07:00:00.000Z'),
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

	expect(result.saveJobs).toHaveLength(1)
	expect(result.successCount).toBe(0)
	expect(result.errorCount).toBe(1)
	expect(result.jobOutcomes).toEqual([
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
	expect(result.saveJobs[0]).toEqual(
		expect.objectContaining({
			id: 'job-reschedule-failure',
			enabled: false,
			lastRunStatus: 'error',
			lastRunError:
				'Failed to reschedule job: Cron expressions must use standard 5-field syntax: minute hour day-of-month month day-of-week.',
		}),
	)
})
