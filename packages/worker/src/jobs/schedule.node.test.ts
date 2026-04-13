import { expect, test } from 'vitest'
import {
	computeNextJobRunAt,
	formatJobScheduleSummary,
	normalizeJobSchedule,
	normalizeJobTimezone,
} from './schedule.ts'

test('computeNextJobRunAt handles timezone-aware cron schedules', () => {
	const nextRunAt = computeNextJobRunAt({
		schedule: {
			cron: '0 8 * * *',
		},
		timezone: 'America/Denver',
		from: '2026-04-13T12:30:00.000Z',
	})

	expect(nextRunAt).toBe('2026-04-13T14:00:00.000Z')
})

test('computeNextJobRunAt handles fixed intervals', () => {
	const nextRunAt = computeNextJobRunAt({
		schedule: {
			intervalMs: 3_600_000,
		},
		from: '2026-04-13T12:30:00.000Z',
	})

	expect(nextRunAt).toBe('2026-04-13T13:30:00.000Z')
})

test('normalizeJobSchedule trims cron expressions and validates interval', () => {
	expect(
		normalizeJobSchedule({
			cron: '  */15   8 * * 1-5  ',
		}),
	).toEqual({
		cron: '*/15 8 * * 1-5',
	})

	expect(
		normalizeJobSchedule({
			intervalMs: 90_500.6,
		}),
	).toEqual({
		intervalMs: 90_500,
	})
})

test('formatJobScheduleSummary includes timezone or interval', () => {
	expect(
		formatJobScheduleSummary({
			schedule: { cron: '0 8 * * *' },
			timezone: 'America/Los_Angeles',
		}),
	).toBe('Runs on cron "0 8 * * *" in America/Los_Angeles')

	expect(
		formatJobScheduleSummary({
			schedule: { intervalMs: 5_000 },
		}),
	).toBe('Runs every 5,000ms')
})

test('normalizeJobTimezone defaults to Kent timezone', () => {
	expect(normalizeJobTimezone(null)).toBe('America/Denver')
})
