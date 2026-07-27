import { expect, test } from 'vitest'
import {
	defaultJobRetentionDays,
	evaluateJobRetentionEligibility,
	isPastOnceJob,
	resolveJobRetentionPreferences,
	validateJobRetentionDaysInput,
} from './job-retention.ts'
import { type JobRecord } from './types.ts'

function createJob(overrides: Partial<JobRecord> = {}): JobRecord {
	return {
		version: 1,
		id: 'job-1',
		userId: 'user-1',
		name: 'Once job',
		sourceId: 'source-1',
		publishedCommit: null,
		storageId: 'job:job-1',
		schedule: {
			type: 'once',
			runAt: '2026-01-01T00:00:00.000Z',
		},
		timezone: 'UTC',
		enabled: false,
		killSwitchEnabled: false,
		preserved: false,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		nextRunAt: '2026-01-01T00:00:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
		...overrides,
	}
}

const preferences = resolveJobRetentionPreferences({})
const now = new Date('2026-04-01T00:00:00.000Z')

test('resolveJobRetentionPreferences uses platform defaults and clamps overrides', () => {
	expect(preferences).toEqual({
		successOnceDays: defaultJobRetentionDays.successOnce,
		failedOrNeverRanOnceDays: defaultJobRetentionDays.failedOrNeverRanOnce,
		disabledRecurringDays: defaultJobRetentionDays.disabledRecurring,
	})
	expect(
		resolveJobRetentionPreferences({
			successOnceDays: 0,
			failedOrNeverRanOnceDays: 999,
			disabledRecurringDays: 30,
		}),
	).toEqual({
		successOnceDays: 1,
		failedOrNeverRanOnceDays: 365,
		disabledRecurringDays: 30,
	})
	expect(validateJobRetentionDaysInput(0)).toBeNull()
	expect(validateJobRetentionDaysInput(366)).toBeNull()
	expect(validateJobRetentionDaysInput(14)).toBe(14)
})

test('package and preserved jobs are never eligible', () => {
	expect(
		evaluateJobRetentionEligibility({
			job: createJob({
				id: 'package-job:pkg:nightly',
				lastRunAt: '2026-01-01T00:00:00.000Z',
				lastRunStatus: 'success',
				runCount: 1,
				successCount: 1,
			}),
			preferences,
			now,
		}),
	).toEqual({ eligible: false, reason: 'package' })

	expect(
		evaluateJobRetentionEligibility({
			job: createJob({
				preserved: true,
				lastRunAt: '2026-01-01T00:00:00.000Z',
				lastRunStatus: 'success',
				runCount: 1,
				successCount: 1,
			}),
			preferences,
			now,
		}),
	).toEqual({ eligible: false, reason: 'preserved' })
})

test('successful past once jobs age out after success retention days', () => {
	const job = createJob({
		enabled: false,
		lastRunAt: '2026-03-01T00:00:00.000Z',
		lastRunStatus: 'success',
		runCount: 1,
		successCount: 1,
	})
	expect(isPastOnceJob(job, now)).toBe(true)
	expect(
		evaluateJobRetentionEligibility({
			job,
			preferences,
			now: new Date('2026-03-10T00:00:00.000Z'),
		}).eligible,
	).toBe(false)

	const decision = evaluateJobRetentionEligibility({
		job,
		preferences,
		now: new Date('2026-03-16T00:00:00.000Z'),
	})
	expect(decision).toEqual({
		eligible: true,
		category: 'success_once',
		ageAnchor: '2026-03-01T00:00:00.000Z',
		retentionDays: 14,
		deleteAfter: '2026-03-15T00:00:00.000Z',
	})
})

test('failed and never-ran past once jobs use the longer once retention', () => {
	const failed = createJob({
		lastRunAt: '2026-01-01T00:00:00.000Z',
		lastRunStatus: 'error',
		runCount: 1,
		errorCount: 1,
	})
	expect(
		evaluateJobRetentionEligibility({
			job: failed,
			preferences,
			now: new Date('2026-03-03T00:00:00.000Z'),
		}),
	).toMatchObject({
		eligible: true,
		category: 'failed_once',
		retentionDays: 60,
	})

	const neverRan = createJob({
		enabled: false,
		runCount: 0,
		schedule: { type: 'once', runAt: '2026-01-01T00:00:00.000Z' },
	})
	expect(
		evaluateJobRetentionEligibility({
			job: neverRan,
			preferences,
			now: new Date('2026-03-05T00:00:00.000Z'),
		}),
	).toMatchObject({
		eligible: true,
		category: 'never_ran_once',
		retentionDays: 60,
		ageAnchor: '2026-01-01T00:00:00.000Z',
	})
})

test('upcoming never-ran once jobs and enabled recurring jobs are skipped', () => {
	expect(
		evaluateJobRetentionEligibility({
			job: createJob({
				enabled: true,
				runCount: 0,
				schedule: { type: 'once', runAt: '2026-01-01T00:00:00.000Z' },
			}),
			preferences,
			now,
		}),
	).toEqual({ eligible: false, reason: 'upcoming_once' })

	expect(
		evaluateJobRetentionEligibility({
			job: createJob({
				enabled: true,
				schedule: { type: 'cron', expression: '0 9 * * *' },
				lastRunAt: '2026-01-01T00:00:00.000Z',
			}),
			preferences,
			now,
		}),
	).toEqual({ eligible: false, reason: 'active_recurring' })

	// Kill switch pauses execution; it must not age out a held recurring job.
	expect(
		evaluateJobRetentionEligibility({
			job: createJob({
				enabled: true,
				killSwitchEnabled: true,
				schedule: { type: 'interval', every: '1h' },
				lastRunAt: '2026-01-01T00:00:00.000Z',
			}),
			preferences,
			now,
		}),
	).toEqual({ eligible: false, reason: 'active_recurring' })
})

test('disabled recurring ad-hoc jobs age out after disabled retention days', () => {
	const job = createJob({
		enabled: false,
		schedule: { type: 'interval', every: '1d' },
		lastRunAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-02T00:00:00.000Z',
	})
	expect(
		evaluateJobRetentionEligibility({
			job,
			preferences,
			now: new Date('2026-04-02T00:00:00.000Z'),
		}),
	).toMatchObject({
		eligible: true,
		category: 'disabled_recurring',
		retentionDays: 90,
		ageAnchor: '2026-01-01T00:00:00.000Z',
	})

	const neverRanDisabled = createJob({
		enabled: false,
		schedule: { type: 'cron', expression: '0 9 * * *' },
		lastRunAt: undefined,
		updatedAt: '2026-01-01T00:00:00.000Z',
	})
	expect(
		evaluateJobRetentionEligibility({
			job: neverRanDisabled,
			preferences,
			now: new Date('2026-04-02T00:00:00.000Z'),
		}),
	).toMatchObject({
		eligible: true,
		category: 'disabled_recurring',
		ageAnchor: '2026-01-01T00:00:00.000Z',
	})
})

test('account retention overrides change eligibility cutoffs', () => {
	const job = createJob({
		lastRunAt: '2026-03-20T00:00:00.000Z',
		lastRunStatus: 'success',
		runCount: 1,
		successCount: 1,
	})
	expect(
		evaluateJobRetentionEligibility({
			job,
			preferences: resolveJobRetentionPreferences({ successOnceDays: 7 }),
			now: new Date('2026-03-28T00:00:00.000Z'),
		}),
	).toMatchObject({
		eligible: true,
		category: 'success_once',
		retentionDays: 7,
	})
})
