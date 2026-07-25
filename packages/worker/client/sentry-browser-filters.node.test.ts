import { expect, test } from 'vitest'
import { filterBrowserAbortSentryEvent } from './sentry-browser-filters.ts'

test('filterBrowserAbortSentryEvent drops AbortError noise and keeps real errors', () => {
	// Production KODY-CLOUDFLARE-23 signature: type Error, AbortError value, no frames.
	expect(
		filterBrowserAbortSentryEvent({
			exception: {
				values: [
					{
						type: 'Error',
						value: 'AbortError: The user aborted a request.',
					},
				],
			},
		}),
	).toBeNull()

	expect(
		filterBrowserAbortSentryEvent({
			exception: {
				values: [{ type: 'AbortError', value: 'The user aborted a request.' }],
			},
		}),
	).toBeNull()

	expect(
		filterBrowserAbortSentryEvent({
			exception: {
				values: [{ type: 'Error', value: 'The operation was aborted.' }],
			},
		}),
	).toBeNull()

	expect(
		filterBrowserAbortSentryEvent(
			{
				exception: {
					values: [{ type: 'Error', value: 'something else' }],
				},
			},
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

	// Timeout aborts and ordinary network failures must still reach Sentry.
	expect(
		filterBrowserAbortSentryEvent({
			exception: {
				values: [
					{
						type: 'Error',
						value: 'AbortError: The operation was aborted due to timeout.',
					},
				],
			},
		}),
	).not.toBeNull()
	expect(
		filterBrowserAbortSentryEvent({
			exception: {
				values: [
					{
						type: 'TypeError',
						value: 'TypeError: Failed to fetch',
					},
				],
			},
		}),
	).not.toBeNull()
})
