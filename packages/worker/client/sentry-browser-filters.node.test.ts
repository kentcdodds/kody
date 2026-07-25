import { expect, test } from 'vitest'
import {
	filterBrowserAbortSentryEvent,
	isBrowserAbortError,
	isBrowserAbortErrorMessage,
	isBrowserAbortSentryEvent,
} from './sentry-browser-filters.ts'

test('isBrowserAbortErrorMessage matches Chromium and common abort texts', () => {
	expect(
		isBrowserAbortErrorMessage('AbortError: The user aborted a request.'),
	).toBe(true)
	expect(isBrowserAbortErrorMessage('The user aborted a request.')).toBe(true)
	expect(isBrowserAbortErrorMessage('The operation was aborted.')).toBe(true)
	expect(
		isBrowserAbortErrorMessage('AbortError: The operation was aborted.'),
	).toBe(true)
	expect(isBrowserAbortErrorMessage('AbortError: aborted')).toBe(true)
	expect(
		isBrowserAbortErrorMessage('NetworkError when attempting to fetch'),
	).toBe(false)
	expect(isBrowserAbortErrorMessage('TypeError: Failed to fetch')).toBe(false)
	expect(
		isBrowserAbortErrorMessage('The operation was aborted due to timeout.'),
	).toBe(false)
	expect(
		isBrowserAbortErrorMessage(
			'AbortError: The operation was aborted due to timeout.',
		),
	).toBe(false)
})

test('isBrowserAbortError recognizes AbortError-named exceptions', () => {
	expect(isBrowserAbortError(new DOMException('aborted', 'AbortError'))).toBe(
		true,
	)
	expect(
		isBrowserAbortError(Object.assign(new Error('x'), { name: 'AbortError' })),
	).toBe(true)
	expect(
		isBrowserAbortError(new Error('AbortError: The user aborted a request.')),
	).toBe(false)
	expect(isBrowserAbortError(null)).toBe(false)
})

test('filterBrowserAbortSentryEvent drops KODY-CLOUDFLARE-23 signature and keeps real errors', () => {
	// Production event: type Error, value AbortError:…, no stack frames.
	const cloudflare23 = {
		exception: {
			values: [
				{
					type: 'Error',
					value: 'AbortError: The user aborted a request.',
				},
			],
		},
	}
	expect(isBrowserAbortSentryEvent(cloudflare23)).toBe(true)
	expect(filterBrowserAbortSentryEvent(cloudflare23)).toBeNull()

	const typedAbort = {
		exception: {
			values: [{ type: 'AbortError', value: 'The user aborted a request.' }],
		},
	}
	expect(filterBrowserAbortSentryEvent(typedAbort)).toBeNull()

	const viaOriginal = {
		exception: {
			values: [{ type: 'Error', value: 'something else' }],
		},
	}
	expect(
		filterBrowserAbortSentryEvent(
			viaOriginal,
			new DOMException('The user aborted a request.', 'AbortError'),
		),
	).toBeNull()

	const realBug = {
		exception: {
			values: [
				{
					type: 'TypeError',
					value:
						"undefined is not an object (evaluating 'r.updateCurrentEntry')",
				},
			],
		},
	}
	expect(filterBrowserAbortSentryEvent(realBug)).toBe(realBug)
	expect(isBrowserAbortSentryEvent(realBug)).toBe(false)
})
