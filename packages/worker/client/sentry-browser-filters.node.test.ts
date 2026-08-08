import { expect, test } from 'vitest'
import {
	filterBrowserAbortSentryEvent,
	filterBrowserInjectedGlobalNoiseSentryEvent,
	filterBrowserSentryEvent,
	filterChromeExtensionObjectNotFoundSentryEvent,
	filterFathomRemoveChildNullSentryEvent,
	filterFirefoxDomPermissionDeniedSentryEvent,
	filterMetaMaskExtensionSentryEvent,
	filterOgTypeMetaQuerySelectorContentSentryEvent,
	filterTwitterInAppBrowserConfigSentryEvent,
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

	// MetaMask inpage.js session restore (issue 7658961865 / KODY-CLOUDFLARE-3X).
	expect(
		filterMetaMaskExtensionSentryEvent({
			exception: {
				values: [
					{
						type: 'i',
						value: 'Failed to connect to MetaMask',
						stacktrace: {
							frames: [
								{
									filename:
										'chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/scripts/inpage.js',
								},
							],
						},
					},
					{
						type: 'Error',
						value: 'MetaMask extension not found',
						stacktrace: {
							frames: [
								{
									abs_path:
										'chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/scripts/inpage.js',
								},
							],
						},
					},
				],
			},
		}),
	).toBeNull()
	// Message alone (no MetaMask extension frame) must not drop app errors.
	expect(
		filterMetaMaskExtensionSentryEvent({
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

	// Twitter/X iOS in-app browser chrome CONFIG (issue 7659616372 /
	// KODY-CLOUDFLARE-43). Requires both the CONFIG wording and a chrome
	// stack function — bare CONFIG ReferenceErrors from app code stay.
	expect(
		filterTwitterInAppBrowserConfigSentryEvent({
			exception: {
				values: [
					{
						type: 'ReferenceError',
						value: "Can't find variable: CONFIG",
						stacktrace: {
							frames: [
								{
									function: 'updateFooterPositions',
									filename: 'https://heykody.app/',
								},
								{
									function: 'updateGapFiller',
									filename: 'https://heykody.app/',
								},
							],
						},
					},
				],
			},
		}),
	).toBeNull()
	expect(
		filterTwitterInAppBrowserConfigSentryEvent({
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

	// Injected unguarded og:type meta probe (issue 7660258027 /
	// KODY-CLOUDFLARE-46). Requires both the Safari evaluating wording and a
	// `global code` frame — same message from app bundles stays.
	expect(
		filterOgTypeMetaQuerySelectorContentSentryEvent({
			exception: {
				values: [
					{
						type: 'TypeError',
						value:
							"null is not an object (evaluating 'document.querySelector(\"meta[property='og:type']\").content')",
						stacktrace: {
							frames: [
								{
									function: 'global code',
									filename: '/guides/what-is-kody',
									abs_path: 'https://heykody.app/guides/what-is-kody',
								},
							],
						},
					},
				],
			},
		}),
	).toBeNull()
	expect(
		filterOgTypeMetaQuerySelectorContentSentryEvent({
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
})
