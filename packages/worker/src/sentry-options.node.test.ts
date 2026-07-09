import { expect, test } from 'vitest'
import { filterRetryableD1LockSentryEvent } from './sentry-options.ts'

test('filterRetryableD1LockSentryEvent drops transient D1 lock contention and keeps other errors', () => {
	expect(
		filterRetryableD1LockSentryEvent({
			exception: {
				values: [
					{
						value: 'D1_ERROR: NOSENTRY database is locked: SQLITE_BUSY',
					},
				],
			},
		}),
	).toBeNull()

	const unrelatedEvent = {
		exception: {
			values: [{ value: 'D1_ERROR: syntax error near INSERTZ' }],
		},
	}
	expect(filterRetryableD1LockSentryEvent(unrelatedEvent)).toBe(unrelatedEvent)
})
