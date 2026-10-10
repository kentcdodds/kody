import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
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
		userId: ownerIdFromStored('user-1'),
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
		expiresAt: null,
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

function evaluate(
	overrides: Partial<JobRecord>,
	at: string | Date = now,
	retention = preferences,
) {
	return evaluateJobRetentionEligibility({
		job: createJob(overrides),
		preferences: retention,
		now: new Date(at),
	})
}

const ranSuccessfully = {
	lastRunStatus: 'success',
	runCount: 1,
	successCount: 1,
} as const

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

test('package, preserved, upcoming once, and active recurring jobs are never eligible', () => {
	const ranAt = { lastRunAt: '2026-01-01T00:00:00.000Z' }
	const cases: Array<[string, Partial<JobRecord>]> = [
		[
			'package',
			{ id: 'package-job:pkg:nightly', ...ranAt, ...ranSuccessfully },
		],
		['preserved', { preserved: true, ...ranAt, ...ranSuccessfully }],
		['upcoming_once', { enabled: true, lastRunAt: undefined }],
		[
			'active_recurring',
			{
				enabled: true,
				schedule: { type: 'cron', expression: '0 9 * * *' },
				...ranAt,
			},
		],
		// Kill switch pauses execution; it must not age out a held recurring job.
		[
			'active_recurring',
			{
				enabled: true,
				killSwitchEnabled: true,
				schedule: { type: 'interval', every: '1h' },
				...ranAt,
			},
		],
	]
	for (const [reason, overrides] of cases) {
		expect(evaluate(overrides)).toEqual({ eligible: false, reason })
	}
})

test('successful past once jobs age out after success retention days', () => {
	const job = { lastRunAt: '2026-03-01T00:00:00.000Z', ...ranSuccessfully }
	expect(isPastOnceJob(createJob(job), now)).toBe(true)
	expect(evaluate(job, '2026-03-10T00:00:00.000Z').eligible).toBe(false)
	expect(evaluate(job, '2026-03-16T00:00:00.000Z')).toEqual({
		eligible: true,
		category: 'success_once',
		ageAnchor: '2026-03-01T00:00:00.000Z',
		retentionDays: 14,
		deleteAfter: '2026-03-15T00:00:00.000Z',
	})
})

test('failed and never-ran past once jobs use the longer once retention', () => {
	expect(
		evaluate(
			{ lastRunAt: '2026-01-01T00:00:00.000Z', lastRunStatus: 'error' },
			'2026-03-03T00:00:00.000Z',
		),
	).toMatchObject({
		eligible: true,
		category: 'failed_once',
		retentionDays: 60,
	})
	expect(
		evaluate({ lastRunAt: undefined }, '2026-03-05T00:00:00.000Z'),
	).toMatchObject({
		eligible: true,
		category: 'never_ran_once',
		retentionDays: 60,
		ageAnchor: '2026-01-01T00:00:00.000Z',
	})
})

test('disabled recurring ad-hoc jobs age out after disabled retention days', () => {
	const at = '2026-04-02T00:00:00.000Z'
	expect(
		evaluate(
			{
				schedule: { type: 'interval', every: '1d' },
				lastRunAt: '2026-01-01T00:00:00.000Z',
				updatedAt: '2026-01-02T00:00:00.000Z',
			},
			at,
		),
	).toMatchObject({
		eligible: true,
		category: 'disabled_recurring',
		retentionDays: 90,
		ageAnchor: '2026-01-01T00:00:00.000Z',
	})
	expect(
		evaluate(
			{
				schedule: { type: 'cron', expression: '0 9 * * *' },
				lastRunAt: undefined,
				updatedAt: '2026-01-01T00:00:00.000Z',
			},
			at,
		),
	).toMatchObject({
		eligible: true,
		category: 'disabled_recurring',
		ageAnchor: '2026-01-01T00:00:00.000Z',
	})
})

test('account retention overrides change eligibility cutoffs', () => {
	expect(
		evaluate(
			{ lastRunAt: '2026-03-20T00:00:00.000Z', ...ranSuccessfully },
			'2026-03-28T00:00:00.000Z',
			resolveJobRetentionPreferences({ successOnceDays: 7 }),
		),
	).toMatchObject({
		eligible: true,
		category: 'success_once',
		retentionDays: 7,
	})
})
