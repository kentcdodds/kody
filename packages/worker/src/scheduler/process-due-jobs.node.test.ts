import { expect, test } from 'vitest'
import { processDueJobs } from './process-due-jobs.ts'
import { type ScheduledJob } from './types.ts'

function createCronJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
	return {
		id: 'job-1',
		name: 'Morning job',
		code: 'async () => ({ ok: true })',
		schedule: {
			type: 'cron',
			expression: '0 7 * * *',
		},
		timezone: 'UTC',
		enabled: true,
		createdAt: '2026-04-12T00:00:00.000Z',
		nextRunAt: '2026-04-12T07:00:00.000Z',
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
				ok: true,
				logs: ['ok'],
				result: { ok: true },
			}
		},
	})

	expect(result.deleteJobIds).toEqual([])
	expect(result.saveJobs).toHaveLength(2)
	expect(result.saveJobs[0]).toMatchObject({
		id: 'job-1',
		lastRunStatus: 'error',
		lastRunError: 'boom',
		lastRunAt: now.toISOString(),
	})
	expect(result.saveJobs[1]).toMatchObject({
		id: 'job-2',
		lastRunStatus: 'success',
		lastRunAt: now.toISOString(),
	})
})

test('processDueJobs deletes one-shot jobs after execution', async () => {
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
				ok: false,
				error: 'expected failure',
				logs: [],
			}
		},
	})

	expect(result.deleteJobIds).toEqual(['job-once'])
	expect(result.saveJobs).toEqual([])
})
