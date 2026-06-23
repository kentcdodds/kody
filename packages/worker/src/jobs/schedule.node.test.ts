import { expect, test } from 'vitest'
import { computeNextRunAt, normalizeJobSchedule } from './schedule.ts'

test('job schedule helpers normalize schedules and compute the next run time', () => {
	expect(
		normalizeJobSchedule({
			type: 'cron',
			expression: '  */15   7 * * 1-5  ',
		}),
	).toEqual({
		type: 'cron',
		expression: '*/15 7 * * 1-5',
	})
	expect(
		normalizeJobSchedule({
			type: 'interval',
			every: ' 05M ',
		}),
	).toEqual({
		type: 'interval',
		every: '5m',
	})

	expect(
		computeNextRunAt({
			schedule: {
				type: 'cron',
				expression: '0 7 * * *',
			},
			timezone: 'America/New_York',
			from: '2026-03-08T10:30:00.000Z',
		}),
	).toBe('2026-03-08T11:00:00.000Z')
	expect(
		computeNextRunAt({
			schedule: {
				type: 'once',
				runAt: '2026-04-17T15:00:00Z',
			},
		}),
	).toBe('2026-04-17T15:00:00.000Z')
	expect(
		computeNextRunAt({
			schedule: {
				type: 'interval',
				every: '15m',
			},
			from: '2026-04-17T15:00:00.000Z',
		}),
	).toBe('2026-04-17T15:15:00.000Z')
})
