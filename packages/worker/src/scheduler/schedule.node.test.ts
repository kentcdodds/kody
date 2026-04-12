import { expect, test } from 'vitest'
import {
	computeNextRunAt,
	formatScheduleSummary,
	normalizeScheduledJobSchedule,
} from './schedule.ts'

test('computeNextRunAt handles timezone-aware cron schedules', () => {
	const nextRunAt = computeNextRunAt({
		schedule: {
			type: 'cron',
			expression: '0 7 * * *',
		},
		timezone: 'America/New_York',
		from: '2026-03-08T10:30:00.000Z',
	})

	expect(nextRunAt).toBe('2026-03-08T11:00:00.000Z')
})

test('computeNextRunAt preserves UTC once schedules', () => {
	const nextRunAt = computeNextRunAt({
		schedule: {
			type: 'once',
			runAt: '2026-04-17T15:00:00Z',
		},
	})

	expect(nextRunAt).toBe('2026-04-17T15:00:00.000Z')
})

test('normalizeScheduledJobSchedule trims cron expressions', () => {
	expect(
		normalizeScheduledJobSchedule({
			type: 'cron',
			expression: '  */15   7 * * 1-5  ',
		}),
	).toEqual({
		type: 'cron',
		expression: '*/15 7 * * 1-5',
	})
})

test('formatScheduleSummary includes timezone for cron jobs', () => {
	expect(
		formatScheduleSummary({
			schedule: {
				type: 'cron',
				expression: '0 7 * * *',
			},
			timezone: 'America/Los_Angeles',
		}),
	).toBe('Runs on cron "0 7 * * *" in America/Los_Angeles')
})
