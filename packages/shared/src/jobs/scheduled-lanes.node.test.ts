import { expect, test } from 'vitest'
import {
	parseScheduledLaneMessage,
	resolveScheduledLaneQueueAction,
	scheduledDispatchMaxRetries,
} from './scheduled-lanes.ts'

test('queue action policy retries only lock contention, acks completed and failed, and preserves the original outcome contract', () => {
	const exhausted = scheduledDispatchMaxRetries + 1
	const retry = (reason: string, delaySeconds: number) => ({
		action: 'retry',
		reason,
		delaySeconds,
	})
	const cases = [
		['completed', 1, { action: 'ack', reason: 'completed' }],
		['failed', 1, { action: 'ack', reason: 'terminal_failure' }],
		['failed', exhausted, { action: 'ack', reason: 'terminal_failure' }],
		['d1_lock_contention', 1, retry('transient_failure', 10)],
		['d1_lock_contention', 2, retry('transient_failure', 30)],
		['d1_lock_contention', 3, retry('transient_failure', 90)],
		['d1_lock_contention', exhausted, retry('retry_exhausted', 90)],
	] as const
	expect(
		cases.map(([outcome, attempts]) =>
			resolveScheduledLaneQueueAction({ outcome, attempts }),
		),
	).toEqual(cases.map(([, , expected]) => expected))

	const scheduledTime = Date.UTC(2026, 0, 1, 12, 0)
	const message = { lane: 'retention', scheduledTime, cron: '*/5 * * * *' }
	expect(parseScheduledLaneMessage(message)).toEqual(message)
})
