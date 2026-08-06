import { expect, test } from 'vitest'
import {
	filterBrowserAbortSentryEvent,
	filterBrowserInjectedGlobalNoiseSentryEvent,
	filterBrowserSentryEvent,
	filterChromeExtensionObjectNotFoundSentryEvent,
	filterFathomRemoveChildNullSentryEvent,
	filterFirefoxDomPermissionDeniedSentryEvent,
} from './sentry-browser-filters.ts'

test('browser Sentry filters drop AbortError and Firefox Xray noise and keep real errors', () => {
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
						value: 'Permission denied',
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
						type: 'ReferenceError',
						value: "Can't find variable: __firefox__",
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
							"undefined is not an object (evaluating 'window.someAppApi.foo')",
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

	// Fathom beacon removeChild-on-null only when a usefathom.com frame is present
	// (issue 7653117289 / KODY-CLOUDFLARE-3Q).
	expect(
		filterFathomRemoveChildNullSentryEvent({
			exception: {
				values: [
					{
						type: 'TypeError',
						value: "Cannot read properties of null (reading 'removeChild')",
						stacktrace: {
							frames: [
								{
									abs_path: 'https://cdn.usefathom.com/script.js',
								},
							],
						},
					},
				],
			},
		}),
	).toBeNull()
	expect(
		filterFathomRemoveChildNullSentryEvent({
			exception: {
				values: [
					{
						type: 'TypeError',
						value: "Cannot read properties of null (reading 'removeChild')",
						stacktrace: {
							frames: [
								{
									abs_path: 'https://heykody.dev/assets/app-chunk.js',
								},
							],
						},
					},
				],
			},
		}),
	).not.toBeNull()
	expect(
		filterFathomRemoveChildNullSentryEvent({
			exception: {
				values: [
					{
						type: 'TypeError',
						value: "Cannot read properties of null (reading 'removeChild')",
						stacktrace: {
							frames: [
								{
									abs_path: 'https://heykody.dev/cdn.usefathom.com/script.js',
								},
							],
						},
					},
				],
			},
		}),
	).not.toBeNull()
	expect(
		filterBrowserSentryEvent({
			exception: {
				values: [
					{
						type: 'TypeError',
						value: "Cannot read properties of null (reading 'removeChild')",
						stacktrace: {
							frames: [
								{
									abs_path: 'https://cdn.usefathom.com/script.js',
								},
							],
						},
					},
				],
			},
		}),
	).toBeNull()

	// Chrome extension IPC object-not-found (issue 7655189301 / KODY-CLOUDFLARE-3S).
	expect(
		filterChromeExtensionObjectNotFoundSentryEvent({
			exception: {
				values: [
					{
						type: 'UnhandledRejection',
						value:
							'Non-Error promise rejection captured with value: Object Not Found Matching Id:3, MethodName:update, ParamCount:4',
					},
				],
			},
		}),
	).toBeNull()
	expect(
		filterChromeExtensionObjectNotFoundSentryEvent(
			{
				exception: {
					values: [{ type: 'UnhandledRejection', value: 'something else' }],
				},
			},
			'Object Not Found Matching Id:2, MethodName:update, ParamCount:4',
		),
	).toBeNull()
	expect(
		filterChromeExtensionObjectNotFoundSentryEvent({
			exception: {
				values: [
					{
						type: 'UnhandledRejection',
						value: 'Object Not Found Matching Id:missing, MethodName:update',
					},
				],
			},
		}),
	).not.toBeNull()
	expect(
		filterBrowserSentryEvent({
			exception: {
				values: [
					{
						type: 'UnhandledRejection',
						value:
							'Non-Error promise rejection captured with value: Object Not Found Matching Id:3, MethodName:update, ParamCount:4',
					},
				],
			},
		}),
	).toBeNull()
})
