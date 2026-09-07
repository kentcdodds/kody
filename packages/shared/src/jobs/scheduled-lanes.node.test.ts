import { expect, test } from 'vitest'
import {
	parseScheduledLaneMessage,
	resolveScheduledLaneQueueAction,
	scheduledDispatchMaxRetries,
} from './scheduled-lanes.ts'

test('queue action policy retries only lock contention, acks completed and failed, and preserves the original outcome contract', () => {
	expect(
		resolveScheduledLaneQueueAction({
			outcome: 'completed',
			attempts: 1,
		}),
	).toEqual({ action: 'ack', reason: 'completed' })
	expect(
		resolveScheduledLaneQueueAction({
			outcome: 'failed',
			attempts: 1,
		}),
	).toEqual({ action: 'ack', reason: 'terminal_failure' })
	expect(
		resolveScheduledLaneQueueAction({
			outcome: 'failed',
			attempts: scheduledDispatchMaxRetries + 1,
		}),
	).toEqual({ action: 'ack', reason: 'terminal_failure' })

	expect(
		resolveScheduledLaneQueueAction({
			outcome: 'd1_lock_contention',
			attempts: 1,
		}),
	).toEqual({
		action: 'retry',
		reason: 'transient_failure',
		delaySeconds: 10,
	})
	expect(
		resolveScheduledLaneQueueAction({
			outcome: 'd1_lock_contention',
			attempts: 2,
		}),
	).toEqual({
		action: 'retry',
		reason: 'transient_failure',
		delaySeconds: 30,
	})
	expect(
		resolveScheduledLaneQueueAction({
			outcome: 'd1_lock_contention',
			attempts: 3,
		}),
	).toEqual({
		action: 'retry',
		reason: 'transient_failure',
		delaySeconds: 90,
	})
	expect(
		resolveScheduledLaneQueueAction({
			outcome: 'd1_lock_contention',
			attempts: scheduledDispatchMaxRetries + 1,
		}),
	).toEqual({
		action: 'retry',
		reason: 'retry_exhausted',
		delaySeconds: 90,
	})

	const scheduledTime = Date.UTC(2026, 0, 1, 12, 0)
	expect(
		parseScheduledLaneMessage({
			lane: 'retention',
			scheduledTime,
			cron: '*/5 * * * *',
		}),
	).toEqual({
		lane: 'retention',
		scheduledTime,
		cron: '*/5 * * * *',
	})
})
