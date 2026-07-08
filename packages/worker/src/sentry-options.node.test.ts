import { expect, test } from 'vitest'
import { filterRetryableD1LockSentryEvent } from './sentry-options.ts'

test('filterRetryableD1LockSentryEvent drops transient D1 SQLITE_BUSY events', () => {
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
})

test('filterRetryableD1LockSentryEvent keeps unrelated errors', () => {
	const event = {
		exception: {
			values: [{ value: 'D1_ERROR: syntax error near INSERTZ' }],
		},
	}
	expect(filterRetryableD1LockSentryEvent(event)).toBe(event)
})
