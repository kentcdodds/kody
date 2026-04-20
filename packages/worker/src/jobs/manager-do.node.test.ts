import { expect, test } from 'vitest'
import { resolveJobManagerAlarmState } from './manager-state.ts'

test('resolveJobManagerAlarmState treats equivalent UTC formats as in sync', () => {
	expect(
		resolveJobManagerAlarmState({
			alarmTimestamp: Date.parse('2026-04-20T18:30:00.000Z'),
			nextRunnableRunAt: '2026-04-20T18:30:00Z',
		}),
	).toEqual({
		alarmScheduledFor: '2026-04-20T18:30:00.000Z',
		alarmInSync: true,
		status: 'armed',
	})
})

test('resolveJobManagerAlarmState marks mismatched alarm times as out of sync', () => {
	expect(
		resolveJobManagerAlarmState({
			alarmTimestamp: Date.parse('2026-04-20T19:00:00.000Z'),
			nextRunnableRunAt: '2026-04-20T18:30:00.000Z',
		}),
	).toEqual({
		alarmScheduledFor: '2026-04-20T19:00:00.000Z',
		alarmInSync: false,
		status: 'out_of_sync',
	})
})

test('resolveJobManagerAlarmState reports idle when no alarm or next runnable job exists', () => {
	expect(
		resolveJobManagerAlarmState({
			alarmTimestamp: null,
			nextRunnableRunAt: null,
		}),
	).toEqual({
		alarmScheduledFor: null,
		alarmInSync: true,
		status: 'idle',
	})
})
