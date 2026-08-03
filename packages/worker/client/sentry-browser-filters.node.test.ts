import { expect, test } from 'vitest'
import {
	filterBrowserAbortSentryEvent,
	filterBrowserSentryEvent,
	filterFirefoxBridgeNoiseSentryEvent,
	filterFirefoxDomPermissionDeniedSentryEvent,
} from './sentry-browser-filters.ts'

test('browser Sentry filters drop AbortError, Firefox Xray, and __firefox__ bridge noise and keep real errors', () => {
	// AbortError family (including originalException), but not timeout/network.
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
		filterBrowserAbortSentryEvent(
			{
				exception: {
					values: [{ type: 'Error', value: 'something else' }],
				},
			},
			new DOMException('The user aborted a request.', 'AbortError'),
		),
	).toBeNull()
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

	// Firefox Xray "Permission denied to access property …" noise only.
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
		filterFirefoxDomPermissionDeniedSentryEvent(
			{
				exception: {
					values: [{ type: 'Error', value: 'something else' }],
				},
			},
			new Error('Permission denied to access property "childNodes"'),
		),
	).toBeNull()
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

	// Firefox bridge / reader-mode `__firefox__` noise (KODY-CLOUDFLARE-3F / 3E).
	expect(
		filterFirefoxBridgeNoiseSentryEvent({
			exception: {
				values: [
					{
						type: 'ReferenceError',
						value: "Can't find variable: __firefox__",
					},
				],
			},
		}),
	).toBeNull()
	expect(
		filterFirefoxBridgeNoiseSentryEvent({
			exception: {
				values: [
					{
						type: 'TypeError',
						value:
							"undefined is not an object (evaluating 'window.__firefox__.reader')",
					},
				],
			},
		}),
	).toBeNull()
	expect(
		filterFirefoxBridgeNoiseSentryEvent({
			exception: {
				values: [
					{
						type: 'ReferenceError',
						value: '__firefox__ is not defined',
					},
				],
			},
		}),
	).toBeNull()
	expect(
		filterFirefoxBridgeNoiseSentryEvent(
			{
				exception: {
					values: [{ type: 'Error', value: 'something else' }],
				},
			},
			new ReferenceError("Can't find variable: __firefox__"),
		),
	).toBeNull()
	// Must not drop unrelated ReferenceError / TypeError / messages that only
	// mention "firefox" without the bridge identifier.
	expect(
		filterFirefoxBridgeNoiseSentryEvent({
			exception: {
				values: [
					{
						type: 'ReferenceError',
						value: "Can't find variable: updateCurrentEntry",
					},
				],
			},
		}),
	).not.toBeNull()
	expect(
		filterFirefoxBridgeNoiseSentryEvent({
			exception: {
				values: [
					{
						type: 'TypeError',
						value:
							"undefined is not an object (evaluating 'n.updateCurrentEntry')",
					},
				],
			},
		}),
	).not.toBeNull()
	expect(
		filterFirefoxBridgeNoiseSentryEvent({
			exception: {
				values: [
					{
						type: 'Error',
						value: 'firefox reader failed',
					},
				],
			},
		}),
	).not.toBeNull()

	const realBug = {
		exception: {
			values: [{ type: 'TypeError', value: 'TypeError: Failed to fetch' }],
		},
	}
	expect(filterBrowserSentryEvent(realBug)).toBe(realBug)
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
	expect(
		filterBrowserSentryEvent({
			exception: {
				values: [
					{
						type: 'ReferenceError',
						value: "Can't find variable: __firefox__",
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
						type: 'TypeError',
						value:
							"undefined is not an object (evaluating 'window.__firefox__.reader')",
					},
				],
			},
		}),
	).toBeNull()
})
