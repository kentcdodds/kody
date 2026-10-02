import { expect, test } from 'vitest'
import {
	filterBrowserAbortSentryEvent,
	filterBrowserInjectedGlobalNoiseSentryEvent,
	filterBrowserSentryEvent,
	filterFirefoxDomPermissionDeniedSentryEvent,
} from './sentry-browser-filters.ts'

type Frame = {
	filename?: string
	abs_path?: string
	absPath?: string
	function?: string
}
type Case = [
	type: string,
	value: string,
	frames?: Array<Frame>,
	originalException?: unknown,
]

function makeEvent([type, value, frames]: Case) {
	return {
		exception: {
			values: [{ type, value, ...(frames ? { stacktrace: { frames } } : {}) }],
		},
	}
}

const droppedBy = (filter: typeof filterBrowserSentryEvent, c: Case) =>
	filter(makeEvent(c), c[3]) === null
const keptBy = (filter: typeof filterBrowserSentryEvent, c: Case) => {
	const event = makeEvent(c)
	return filter(event, c[3]) === event
}
const fr = (name: string, filename: string): Frame => ({
	function: name,
	filename,
})
const withStack = <E extends Error>(error: E, stack: string) =>
	Object.assign(error, { stack })

const kodyEntry = fr('boot', 'https://kody.codes/assets/entry.js')
const appChunk = { abs_path: 'https://heykody.dev/assets/app-chunk.js' }
const hostHooks =
	'chrome-extension://iohjgamcilhbgmhbnllfolmkmmekfmci/injected-scripts/host-additional-hooks.js'
const perfInject = fr(
	'Performance.get',
	'chrome-extension://nmpbkbkalejlobohneicicgoojjokopi/data/content_script/page_context/inject.js',
)
const mIdExecutors =
	'chrome-extension://eppiocemhmnlbhjplcgkofciiegomcon/executors/200.js'
const mIdMessage = "Cannot read properties of undefined (reading 'M_ID')"
const readingUrl = "Cannot read properties of undefined (reading 'url')"
const webkitMessage =
	"undefined is not an object (evaluating 'window.webkit.messageHandlers')"
const ogTypeMessage =
	"null is not an object (evaluating 'document.querySelector(\"meta[property='og:type']\").content')"
const tabNotFound = 'Invalid call to runtime.sendMessage(). Tab not found.'
const objectCaptured = 'Object captured as exception with keys: code, message'
const highlightChunkMessage =
	'Failed to fetch dynamically imported module: https://kody.codes/assets/syntax-highlight-core-VCFYP6MU.js'
const blogChunkMessage =
	'Failed to fetch dynamically imported module: https://kody.codes/assets/blog-area-ABC123.js'
const frameResolveFrame = fr(
	'createFrameResolveInit',
	'../client/frame-resolve.ts',
)
const turnstileCode = '[Cloudflare Turnstile] Error: 300010.'
const insertBeforeMessage =
	"Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node."
const reconcileFrame = fr(
	'moveDomRange',
	'@remix-run/component/dist/runtime/reconcile',
)
const crabAppleMessage =
	'Error: [CrabApple] Failed to hard-spoof navigator.userAgent: TypeError: Cannot redefine property: userAgent'
const spoofFrames = [
	{ function: '<anonymous>' },
	{ function: 'spoofBrowserAndPlatform' },
]

test('individual browser Sentry filters drop AbortError, Firefox Xray, and injected-global noise', () => {
	const cases: Array<[typeof filterBrowserSentryEvent, Case, boolean]> = [
		[
			filterBrowserAbortSentryEvent,
			['Error', 'AbortError: The user aborted a request.'],
			true,
		],
		[
			filterBrowserAbortSentryEvent,
			[
				'Error',
				'something else',
				undefined,
				new DOMException('The user aborted a request.', 'AbortError'),
			],
			true,
		],
		[
			filterBrowserAbortSentryEvent,
			['Error', 'AbortError: The operation was aborted due to timeout.'],
			false,
		],
		[
			filterFirefoxDomPermissionDeniedSentryEvent,
			['Error', 'Permission denied to access property "childNodes"'],
			true,
		],
		[
			filterFirefoxDomPermissionDeniedSentryEvent,
			['Error', 'Permission denied'],
			false,
		],
		[
			filterBrowserInjectedGlobalNoiseSentryEvent,
			[
				'TypeError',
				"undefined is not an object (evaluating 'window.ethereum.selectedAddress = undefined')",
			],
			true,
		],
		[
			filterBrowserInjectedGlobalNoiseSentryEvent,
			['ReferenceError', "Can't find variable: __firefox__"],
			true,
		],
		[
			filterBrowserInjectedGlobalNoiseSentryEvent,
			[
				'TypeError',
				"undefined is not an object (evaluating 'window.someAppApi.foo')",
			],
			false,
		],
	]
	expect(
		cases.filter(([filter, c, dropped]) =>
			dropped ? !droppedBy(filter, c) : !keptBy(filter, c),
		),
	).toEqual([])
})

test('filterBrowserSentryEvent drops third-party and platform noise and keeps real errors', () => {
	const dropped: Array<Case> = [
		['Error', 'AbortError: The user aborted a request.'],
		// Fathom script DOM crash.
		[
			'TypeError',
			"Cannot read properties of null (reading 'removeChild')",
			[{ abs_path: 'https://cdn.usefathom.com/script.js' }],
		],
		// Chrome extension noise families.
		[
			'UnhandledRejection',
			'Non-Error promise rejection captured with value: Object Not Found Matching Id:3, MethodName:update, ParamCount:4',
		],
		[
			'Error',
			'Error: Could not establish connection. Receiving end does not exist.',
		],
		['Error', tabNotFound],
		['Error', `Error: ${tabNotFound}`],
		['Error', 'something else', undefined, new Error(tabNotFound)],
		[
			'Error',
			'MetaMask extension not found',
			[
				{
					filename:
						'chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/scripts/inpage.js',
				},
			],
		],
		// MetaMask plain-object rejection (KODY-CLOUDFLARE-64): buffered
		// unhandledrejection with { code: 4001, message: "wallet must has…" }.
		[
			'Error',
			objectCaptured,
			undefined,
			{ code: 4001, message: 'wallet must has at least one account' },
		],
		['Error', 'wallet must has at least one account'],
		[
			'WrappedError',
			'Client has been destroyed',
			[{ filename: hostHooks }, { function: 'a6.send', abs_path: hostHooks }],
		],
		[
			'RangeError',
			'Maximum call stack size exceeded',
			[perfInject, fr('Reflect.get', '<anonymous>')],
		],
		[
			'TypeError',
			mIdMessage,
			[fr('E', mIdExecutors), { function: 'Y', abs_path: mIdExecutors }],
		],
		[
			'TypeError',
			"Cannot read property 'M_ID' of undefined",
			[fr('E', 'chrome-extension://abcd/executors/200.js')],
			new TypeError("Cannot read property 'M_ID' of undefined"),
		],
		// Twitter / X in-app browser globals.
		[
			'ReferenceError',
			'CONFIG is not defined',
			[{ function: 'updateGapFiller', abs_path: 'https://heykody.app/' }],
		],
		[
			'TypeError',
			webkitMessage,
			[
				{
					function: 'sendScrollEvent',
					abs_path: 'https://kody.codes/@kentcdodds/origin',
				},
			],
		],
		[
			'TypeError',
			`TypeError: ${ogTypeMessage}`,
			[
				{
					function: 'global code',
					absPath: 'https://heykody.app/guides/what-is-kody',
				},
			],
		],
		// WorkerGlobalScope blob importScripts NetworkError (KODY-CLOUDFLARE-5G).
		[
			'Error',
			"Uncaught NetworkError: Failed to execute 'importScripts' on 'WorkerGlobalScope': The script at 'blob:https://kody.codes/746a7af2-37c5-4c0d-953f-661052a239a3' failed to load.",
			[
				{
					filename:
						'blob:https://kody.codes/da30da39-78fc-444b-abb1-01ebd8bfc126',
				},
			],
		],
		// syntax-highlight-core dynamic import misses (KODY-CLOUDFLARE-5W).
		['TypeError', highlightChunkMessage],
		[
			'TypeError',
			'something else',
			undefined,
			new TypeError(highlightChunkMessage),
		],
		// resolveFrame fetch network TypeErrors (KODY-CLOUDFLARE-5Y); Safari often
		// keeps only the immediate fetchFrameResolve caller.
		[
			'TypeError',
			'Load failed',
			[fr('app.resolveFrame', '../client/entry.tsx')],
		],
		[
			'TypeError',
			'Failed to fetch',
			undefined,
			withStack(
				new TypeError('Failed to fetch'),
				'resolveFrame@https://kody.codes/client-entry.js:3:61347',
			),
		],
		[
			'TypeError',
			'Load failed',
			undefined,
			withStack(
				new TypeError('Load failed'),
				'fetchFrameResolve@https://kody.codes/client-entry.js:3:61000',
			),
		],
		[
			'TypeError',
			'Load failed',
			[fr('fetchFrameResolve', '../client/frame-resolve.ts')],
		],
		// Chromium "Failed to fetch (host)" via createFrameResolveInit (KODY-6A).
		[
			'TypeError',
			'Failed to fetch (kody.codes)',
			[frameResolveFrame, fr('boot', '../client/entry.tsx')],
		],
		[
			'TypeError',
			'Failed to fetch (kody.codes)',
			undefined,
			withStack(
				new TypeError('Failed to fetch (kody.codes)'),
				'TypeError: Failed to fetch\n    at Yn (https://kody.codes/client-entry.js:3:2497)\n    at Object.resolveFrame (https://kody.codes/client-entry.js:3:76468)',
			),
		],
		// Turnstile client load and challenge failures (KODY-6D / KODY-6E).
		[
			'Error',
			'Turnstile script failed to load.',
			[fr('r.addEventListener.once', '../../client/public-form-protection.ts')],
		],
		[
			'Error',
			'something else',
			undefined,
			new Error('Turnstile API did not initialize.'),
		],
		['TurnstileError', turnstileCode],
		[
			'Error',
			'wrapped',
			undefined,
			Object.assign(new Error(turnstileCode), { name: 'TurnstileError' }),
		],
		// Local Vite HMR and loopback frame-resolve 500s (KODY-6Z).
		[
			'Error',
			'Frame resolve failed (500) for http://localhost:3742/',
			[
				{
					function: 'Object.resolveFrame',
					filename: '/packages/worker/client/entry.tsx',
					absPath: 'http://localhost:3742/packages/worker/client/entry.tsx',
				},
			],
		],
		[
			'TypeError',
			readingUrl,
			[
				{
					function: 'Object.callComponentRenderForHmr',
					filename:
						'/node_modules/.vite/deps/remix_component-hmr_runtime_browser.js',
					absPath:
						'http://localhost:3742/node_modules/.vite/deps/remix_component-hmr_runtime_browser.js',
				},
			],
		],
		[
			'Error',
			'Client hydration error',
			undefined,
			withStack(
				new Error('Frame resolve failed (500) for http://127.0.0.1:3742/'),
				'Error: Frame resolve failed (500) for http://127.0.0.1:3742/\n    at Object.resolveFrame (http://127.0.0.1:3742/packages/worker/client/entry.tsx:80:11)',
			),
		],
		// Remix reconcile insertBefore NotFoundError (KODY-7N).
		['NotFoundError', insertBeforeMessage, [reconcileFrame]],
		[
			'NotFoundError',
			`NotFoundError: ${insertBeforeMessage}`,
			undefined,
			withStack(
				new DOMException(insertBeforeMessage, 'NotFoundError'),
				`NotFoundError: ${insertBeforeMessage}\n    at ka (@remix-run/component/dist/runtime/reconcile:1:1)`,
			),
		],
		// CrabApple navigator.userAgent hard-spoof noise (KODY-80).
		['Error', crabAppleMessage, spoofFrames],
		['Error', 'something else', undefined, new Error(crabAppleMessage)],
	]
	expect(
		dropped.filter((c) => !droppedBy(filterBrowserSentryEvent, c)),
	).toEqual([])

	// Near-misses: same message without the third-party frame/marker, or the
	// third-party frame mixed with first-party frames.
	const kept: Array<Case> = [
		['TypeError', 'TypeError: Failed to fetch'],
		[
			'TypeError',
			"Cannot read properties of null (reading 'removeChild')",
			[appChunk],
		],
		['UnhandledRejection', 'something else entirely'],
		['Error', 'Could not establish connection to the MCP server.'],
		['Error', 'Invalid call to runtime.sendMessage(). Extension gone.'],
		['Error', 'Failed to connect to MetaMask', [appChunk]],
		[
			'Error',
			objectCaptured,
			undefined,
			{ code: 4001, message: 'User rejected the request.' },
		],
		['WrappedError', 'Client has been destroyed', [kodyEntry]],
		[
			'Error',
			'Client has been destroyed during hydrate',
			[{ filename: hostHooks }],
		],
		['RangeError', 'Maximum call stack size exceeded', [perfInject, kodyEntry]],
		[
			'RangeError',
			'Maximum call stack size exceeded',
			[fr('scheduleNext', '../client/copy-text-button.tsx')],
		],
		[
			'TypeError',
			mIdMessage,
			[fr('readSession', 'https://kody.codes/assets/entry.js')],
		],
		[
			'TypeError',
			`TypeError: ${mIdMessage}`,
			[fr('Y', mIdExecutors), kodyEntry],
		],
		['TypeError', mIdMessage, [fr('Y', mIdExecutors), { function: 'boot' }]],
		['TypeError', readingUrl, [fr('Y', mIdExecutors)]],
		[
			'ReferenceError',
			"Can't find variable: CONFIG",
			[fr('boot', 'https://heykody.app/assets/entry.js')],
		],
		['TypeError', webkitMessage, [kodyEntry]],
		[
			'TypeError',
			ogTypeMessage,
			[fr('applyDocumentHead', 'https://heykody.app/assets/document-head.js')],
		],
		['NetworkError', 'Failed to fetch'],
		// Other hashed asset chunk misses stay visible (boot reload path), even
		// with a frame-resolve frame.
		['TypeError', blogChunkMessage],
		['TypeError', blogChunkMessage, [frameResolveFrame]],
		['TypeError', 'Load failed', [fr('someOtherFetch', 'app.js')]],
		['Error', 'Turnstile widget host missing in layout'],
		// Production homepage SSR 500s and readRouterUrl crashes stay visible.
		[
			'Error',
			'Frame resolve failed (500) for https://kody.codes/',
			[
				{
					function: 'Object.resolveFrame',
					filename: '../client/entry.tsx',
					absPath: 'https://kody.codes/client-entry.js',
				},
			],
		],
		[
			'TypeError',
			readingUrl,
			[
				{
					function: 'readRouterUrl',
					filename: '../client/router-location.tsx',
					absPath: 'https://kody.codes/assets/entry-abc.js',
				},
			],
		],
		['NotFoundError', insertBeforeMessage, [fr('boot', '../client/entry.tsx')]],
		// KODY-5E-style HierarchyRequestError stays visible.
		['HierarchyRequestError', insertBeforeMessage, [reconcileFrame]],
		[
			'TypeError',
			'TypeError: Cannot redefine property: userAgent',
			spoofFrames,
		],
	]
	expect(kept.filter((c) => !keptBy(filterBrowserSentryEvent, c))).toEqual([])
})
