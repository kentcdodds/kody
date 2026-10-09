import { expect, test } from 'vitest'
import {
	markSentryReported,
	wasSentryReported,
} from '#app/sentry-reported-error.ts'

test('markSentryReported remembers object errors and ignores primitives', () => {
	const error = new Error('ssr failed')
	expect(wasSentryReported(error)).toBe(false)
	markSentryReported(error)
	expect(wasSentryReported(error)).toBe(true)

	markSentryReported('string')
	markSentryReported(null)
	markSentryReported(undefined)
	expect(wasSentryReported('string')).toBe(false)
	expect(wasSentryReported(null)).toBe(false)
	expect(wasSentryReported(undefined)).toBe(false)
})
