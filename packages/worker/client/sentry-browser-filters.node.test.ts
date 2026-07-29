import { expect, test } from 'vitest'
import {
	filterBrowserAbortSentryEvent,
	filterBrowserSentryEvent,
	filterFirefoxDomPermissionDeniedSentryEvent,
} from './sentry-browser-filters.ts'

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

test('filterFirefoxDomPermissionDeniedSentryEvent drops Firefox Xray noise and keeps real errors', () => {
	// Production 7639685398: Remix hydration / Replay startRecording on Firefox.
	expect(
		filterFirefoxDomPermissionDeniedSentryEvent({
			exception: {
				values: [
					{
						type: 'Error',
						value: 'Permission denied to access property "childNodes"',
					},
				],
			},
		}),
	).toBeNull()

	expect(
		filterFirefoxDomPermissionDeniedSentryEvent({
			exception: {
				values: [
					{
						type: 'Error',
						value: 'Permission denied to access property "nodeType"',
					},
				],
			},
		}),
	).toBeNull()

	expect(
		filterFirefoxDomPermissionDeniedSentryEvent({
			exception: {
				values: [
					{
						type: 'DOMException',
						value:
							'Permission denied to access property "document" on cross-origin object',
					},
				],
			},
		}),
	).toBeNull()

	expect(
		filterFirefoxDomPermissionDeniedSentryEvent(
			{
				exception: {
					values: [{ type: 'Error', value: 'something else' }],
				},
			},
			new Error('Permission denied to access property "childNodes"'),
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
	expect(filterFirefoxDomPermissionDeniedSentryEvent(realBug)).toBe(realBug)

	// Broader SecurityError / permission wording must still reach Sentry.
	expect(
		filterFirefoxDomPermissionDeniedSentryEvent({
			exception: {
				values: [
					{
						type: 'SecurityError',
						value:
							'CSSStyleSheet.cssRules getter: Not allowed to access cross-origin stylesheet',
					},
				],
			},
		}),
	).not.toBeNull()
	expect(
		filterFirefoxDomPermissionDeniedSentryEvent({
			exception: {
				values: [
					{
						type: 'Error',
						value: 'Permission denied',
					},
				],
			},
		}),
	).not.toBeNull()
})

test('filterBrowserSentryEvent chains abort and Firefox DOM permission filters', () => {
	expect(
		filterBrowserSentryEvent({
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
		filterBrowserSentryEvent({
			exception: {
				values: [
					{
						type: 'Error',
						value: 'Permission denied to access property "childNodes"',
					},
				],
			},
		}),
	).toBeNull()

	const realBug = {
		exception: {
			values: [{ type: 'TypeError', value: 'TypeError: Failed to fetch' }],
		},
	}
	expect(filterBrowserSentryEvent(realBug)).toBe(realBug)
})
