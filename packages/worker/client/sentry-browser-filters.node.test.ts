import { expect, test } from 'vitest'
import {
	filterBrowserAbortSentryEvent,
	filterBrowserInjectedGlobalNoiseSentryEvent,
	filterBrowserSentryEvent,
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

	// Composed filter: one drop + one keep per third-party noise family.
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
	expect(
		filterBrowserSentryEvent({
			exception: {
				values: [
					{
						type: 'UnhandledRejection',
						value: 'something else entirely',
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
						type: 'Error',
						value:
							'Error: Could not establish connection. Receiving end does not exist.',
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
						value: 'Could not establish connection to the MCP server.',
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
						type: 'Error',
						value: 'MetaMask extension not found',
						stacktrace: {
							frames: [
								{
									filename:
										'chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/scripts/inpage.js',
								},
							],
						},
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
						value: 'Failed to connect to MetaMask',
						stacktrace: {
							frames: [{ abs_path: 'https://heykody.dev/assets/app-chunk.js' }],
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
						type: 'ReferenceError',
						value: 'CONFIG is not defined',
						stacktrace: {
							frames: [
								{
									function: 'updateGapFiller',
									abs_path: 'https://heykody.app/',
								},
							],
						},
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
						value: "Can't find variable: CONFIG",
						stacktrace: {
							frames: [
								{
									function: 'boot',
									filename: 'https://heykody.app/assets/entry.js',
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
						value:
							"TypeError: null is not an object (evaluating 'document.querySelector(\"meta[property='og:type']\").content')",
						stacktrace: {
							frames: [
								{
									function: 'global code',
									absPath: 'https://heykody.app/guides/what-is-kody',
								},
							],
						},
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
							"null is not an object (evaluating 'document.querySelector(\"meta[property='og:type']\").content')",
						stacktrace: {
							frames: [
								{
									function: 'applyDocumentHead',
									filename: 'https://heykody.app/assets/document-head.js',
								},
							],
						},
					},
				],
			},
		}),
	).not.toBeNull()
})
