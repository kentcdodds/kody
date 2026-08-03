import { expect, test } from 'vitest'
import {
	filterBrowserAbortSentryEvent,
	filterBrowserInjectedGlobalNoiseSentryEvent,
	filterBrowserSentryEvent,
	filterFirefoxDomPermissionDeniedSentryEvent,
} from './sentry-browser-filters.ts'

test('browser Sentry filters drop AbortError and Firefox Xray noise and keep real errors', () => {
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

	// Injected wallet / Firefox-iOS bridge globals only (issue 7648833360).
	expect(
		filterBrowserInjectedGlobalNoiseSentryEvent({
			exception: {
				values: [
					{
						type: 'TypeError',
						value:
							"undefined is not an object (evaluating 'window.ethereum.selectedAddress = undefined')",
					},
				],
			},
		}),
	).toBeNull()
	expect(
		filterBrowserInjectedGlobalNoiseSentryEvent({
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
		filterBrowserInjectedGlobalNoiseSentryEvent({
			exception: {
				values: [
					{
						type: 'TypeError',
						value:
							"undefined is not an object (evaluating 'window.__firefox__.refresh_youtube_quality_2E41B6CA94114F3CB0CAF4E4DA93D5A8')",
					},
				],
			},
		}),
	).toBeNull()
	expect(
		filterBrowserInjectedGlobalNoiseSentryEvent({
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
		filterBrowserInjectedGlobalNoiseSentryEvent(
			{
				exception: {
					values: [{ type: 'Error', value: 'something else' }],
				},
			},
			new TypeError(
				"undefined is not an object (evaluating 'window.ethereum.selectedAddress = undefined')",
			),
		),
	).toBeNull()
	expect(
		filterBrowserInjectedGlobalNoiseSentryEvent({
			exception: {
				values: [
					{
						type: 'TypeError',
						value:
							"undefined is not an object (evaluating 'window.someAppApi.foo')",
					},
				],
			},
		}),
	).not.toBeNull()
	expect(
		filterBrowserInjectedGlobalNoiseSentryEvent({
			exception: {
				values: [
					{
						type: 'ReferenceError',
						value: "Can't find variable: ethereum",
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
						type: 'TypeError',
						value:
							"undefined is not an object (evaluating 'window.ethereum.selectedAddress = undefined')",
					},
				],
			},
		}),
	).toBeNull()
})
