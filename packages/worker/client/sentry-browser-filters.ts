/**
 * Browser Sentry event filters. Kept free of `@sentry/browser` imports so unit
 * tests can exercise the predicates with plain event shapes.
 */

type SentryStackFrame = {
	filename?: string
	abs_path?: string
	absPath?: string
}

type SentryExceptionValue = {
	type?: string
	value?: string
	stacktrace?: {
		frames?: Array<SentryStackFrame>
	}
}

export type SentryErrorEventLike = {
	message?: string
	exception?: {
		values?: Array<SentryExceptionValue>
	}
}

function sentryEventMessages(event: SentryErrorEventLike) {
	return [
		event.message,
		...(event.exception?.values?.map((value) => value.value) ?? []),
	]
}

function sentryEventStackFrameUrls(event: SentryErrorEventLike) {
	const urls: Array<string> = []
	for (const value of event.exception?.values ?? []) {
		for (const frame of value.stacktrace?.frames ?? []) {
			for (const candidate of [frame.abs_path, frame.absPath, frame.filename]) {
				if (typeof candidate === 'string' && candidate.length > 0) {
					urls.push(candidate)
				}
			}
		}
	}
	return urls
}

/**
 * Chromium/Edge fetch abort text from KODY-CLOUDFLARE-23 and common browser
 * variants. Matching is intentionally narrow: only these exact abort strings
 * (plus AbortError-named exceptions via `isBrowserAbortError`) — never
 * blanket-drop network errors or timeout wording.
 */
const browserAbortErrorMessages = new Set([
	'AbortError: The user aborted a request.',
	'The user aborted a request.',
	'AbortError: The operation was aborted.',
	'The operation was aborted.',
	'AbortError: aborted',
])

export function isBrowserAbortErrorMessage(message: string) {
	return browserAbortErrorMessages.has(message)
}

export function isBrowserAbortError(error: unknown) {
	if (typeof error !== 'object' || error === null) return false
	return 'name' in error && error.name === 'AbortError'
}

/**
 * Drop expected browser AbortError noise (user navigated away, superseding
 * SPA navigation aborted an in-flight fetch, etc.). These surface as
 * unhandledrejection via `auto.browser.global_handlers.onunhandledrejection`
 * and are not actionable product defects.
 */
export function isBrowserAbortSentryEvent(
	event: SentryErrorEventLike,
	originalException?: unknown,
) {
	if (isBrowserAbortError(originalException)) return true
	if (
		event.exception?.values?.some(
			(value) =>
				value.type === 'AbortError' ||
				(value.type === 'DOMException' &&
					typeof value.value === 'string' &&
					isBrowserAbortErrorMessage(value.value)),
		)
	) {
		return true
	}
	return sentryEventMessages(event).some(
		(message) =>
			typeof message === 'string' && isBrowserAbortErrorMessage(message),
	)
}

export function filterBrowserAbortSentryEvent<T extends SentryErrorEventLike>(
	event: T,
	originalException?: unknown,
): T | null {
	if (isBrowserAbortSentryEvent(event, originalException)) return null
	return event
}

/**
 * Firefox throws when page JS (Remix hydration or Sentry Session Replay /
 * rrweb `startRecording`) touches a DOM node the content compartment cannot
 * read — typically an extension-injected Xray wrapper or a cross-origin
 * object. Signature from production issue 7639685398 / MDN
 * "Permission denied to access property". Not actionable in app code.
 *
 * Match is intentionally narrow: only this Firefox wording (optional
 * "on cross-origin object" suffix). Never blanket-drop SecurityError /
 * DOMException generally.
 */
const firefoxDomPermissionDeniedMessage =
	/^Permission denied to access property ["'][^"']+["'](?: on cross-origin object)?\.?$/

export function isFirefoxDomPermissionDeniedMessage(message: string) {
	return firefoxDomPermissionDeniedMessage.test(message)
}

export function isFirefoxDomPermissionDeniedError(error: unknown) {
	if (typeof error !== 'object' || error === null) return false
	if (!('message' in error) || typeof error.message !== 'string') return false
	return isFirefoxDomPermissionDeniedMessage(error.message)
}

export function isFirefoxDomPermissionDeniedSentryEvent(
	event: SentryErrorEventLike,
	originalException?: unknown,
) {
	if (isFirefoxDomPermissionDeniedError(originalException)) return true
	return sentryEventMessages(event).some(
		(message) =>
			typeof message === 'string' &&
			isFirefoxDomPermissionDeniedMessage(message),
	)
}

export function filterFirefoxDomPermissionDeniedSentryEvent<
	T extends SentryErrorEventLike,
>(event: T, originalException?: unknown): T | null {
	if (isFirefoxDomPermissionDeniedSentryEvent(event, originalException)) {
		return null
	}
	return event
}

/**
 * Wallet / browser-injected globals that throw from page `global code`, not
 * from Kody bundles (no app code references these). Production signatures from
 * Brave iOS issue 7648833360 and sibling 7648833403:
 * - `undefined is not an object (evaluating 'window.ethereum…')`
 * - `undefined is not an object (evaluating 'window.__firefox__…')`
 * - `Can't find variable: __firefox__`
 *
 * Match is intentionally narrow: only these injected-global access patterns.
 * Never blanket-drop TypeError / ReferenceError.
 */
export function isBrowserInjectedGlobalNoiseMessage(message: string) {
	const withoutTypePrefix = message
		.trim()
		.replace(/^(?:TypeError|ReferenceError):\s*/i, '')
	return (
		/^undefined is not an object \(evaluating ['"]window\.(?:ethereum|__firefox__)\./i.test(
			withoutTypePrefix,
		) ||
		/^Can'?t find variable: __firefox__\.?$/i.test(withoutTypePrefix) ||
		/^Cannot find variable: __firefox__\.?$/i.test(withoutTypePrefix) ||
		/^__firefox__ is not defined\.?$/i.test(withoutTypePrefix)
	)
}

export function isBrowserInjectedGlobalNoiseError(error: unknown) {
	if (typeof error === 'string') {
		return isBrowserInjectedGlobalNoiseMessage(error)
	}
	if (typeof error !== 'object' || error === null) return false
	if (!('message' in error) || typeof error.message !== 'string') return false
	return isBrowserInjectedGlobalNoiseMessage(error.message)
}

export function isBrowserInjectedGlobalNoiseSentryEvent(
	event: SentryErrorEventLike,
	originalException?: unknown,
) {
	if (isBrowserInjectedGlobalNoiseError(originalException)) return true
	return sentryEventMessages(event).some(
		(message) =>
			typeof message === 'string' &&
			isBrowserInjectedGlobalNoiseMessage(message),
	)
}

export function filterBrowserInjectedGlobalNoiseSentryEvent<
	T extends SentryErrorEventLike,
>(event: T, originalException?: unknown): T | null {
	if (isBrowserInjectedGlobalNoiseSentryEvent(event, originalException)) {
		return null
	}
	return event
}

/**
 * Fathom Analytics (`cdn.usefathom.com/script.js`) tracks pageviews with a
 * temporary `<img>` beacon and removes it from `load`/`error` handlers via
 * `img.parentNode.removeChild(img)`. When the beacon was already detached
 * (SPA navigation / soft reload), `parentNode` is null and Chromium throws.
 * Signature from production issue 7653117289 / KODY-CLOUDFLARE-3Q.
 *
 * Match is intentionally narrow: removeChild-on-null TypeError text AND a
 * stack frame from the Fathom CDN. Never blanket-drop removeChild errors from
 * app code.
 */
const fathomRemoveChildNullMessage =
	/^(?:TypeError:\s*)?Cannot read propert(?:y|ies) of null \(reading ['"]removeChild['"]\)$/

const fathomAnalyticsHostname = 'cdn.usefathom.com'

export function isFathomRemoveChildNullMessage(message: string) {
	return fathomRemoveChildNullMessage.test(message.trim())
}

export function isFathomAnalyticsStackFrameUrl(url: string) {
	try {
		return (
			new URL(url, 'https://sentry.invalid').hostname ===
			fathomAnalyticsHostname
		)
	} catch {
		return false
	}
}

export function isFathomRemoveChildNullSentryEvent(
	event: SentryErrorEventLike,
) {
	const hasRemoveChildNull = sentryEventMessages(event).some(
		(message) =>
			typeof message === 'string' && isFathomRemoveChildNullMessage(message),
	)
	if (!hasRemoveChildNull) return false
	return sentryEventStackFrameUrls(event).some(isFathomAnalyticsStackFrameUrl)
}

export function filterFathomRemoveChildNullSentryEvent<
	T extends SentryErrorEventLike,
>(event: T): T | null {
	if (isFathomRemoveChildNullSentryEvent(event)) return null
	return event
}

/**
 * Chrome extension messaging noise: when an extension calls a Chrome API
 * (e.g. `tabs.update`) against an object id that no longer exists, Chromium
 * rejects with this exact IPC wording. The rejected promise is often
 * unhandled, so Sentry's `onunhandledrejection` handler captures it as a
 * non-Error rejection on the host page — with no app stack frames.
 *
 * Signature from production issue 7655189301 / KODY-CLOUDFLARE-3S (breadcrumb
 * showed an antifingerprint extension injecting into heykody.dev). Match is
 * intentionally narrow: only this Chrome "Object Not Found Matching Id…,
 * MethodName…, ParamCount…" form (optionally wrapped by Sentry's Non-Error
 * rejection preface). Never blanket-drop UnhandledRejection.
 */
const chromeExtensionObjectNotFoundMessage =
	/(?:^|\b)Object Not Found Matching Id:\d+, MethodName:\w+, ParamCount:\d+\b/

export function isChromeExtensionObjectNotFoundMessage(message: string) {
	return chromeExtensionObjectNotFoundMessage.test(message.trim())
}

export function isChromeExtensionObjectNotFoundError(error: unknown) {
	if (typeof error === 'string') {
		return isChromeExtensionObjectNotFoundMessage(error)
	}
	if (typeof error !== 'object' || error === null) return false
	if (!('message' in error) || typeof error.message !== 'string') return false
	return isChromeExtensionObjectNotFoundMessage(error.message)
}

export function isChromeExtensionObjectNotFoundSentryEvent(
	event: SentryErrorEventLike,
	originalException?: unknown,
) {
	if (isChromeExtensionObjectNotFoundError(originalException)) return true
	return sentryEventMessages(event).some(
		(message) =>
			typeof message === 'string' &&
			isChromeExtensionObjectNotFoundMessage(message),
	)
}

export function filterChromeExtensionObjectNotFoundSentryEvent<
	T extends SentryErrorEventLike,
>(event: T, originalException?: unknown): T | null {
	if (isChromeExtensionObjectNotFoundSentryEvent(event, originalException)) {
		return null
	}
	return event
}

/** Combined browser beforeSend / capture gate used by the client SDK. */
export function filterBrowserSentryEvent<T extends SentryErrorEventLike>(
	event: T,
	originalException?: unknown,
): T | null {
	if (filterBrowserAbortSentryEvent(event, originalException) === null) {
		return null
	}
	if (
		filterFirefoxDomPermissionDeniedSentryEvent(event, originalException) ===
		null
	) {
		return null
	}
	if (
		filterBrowserInjectedGlobalNoiseSentryEvent(event, originalException) ===
		null
	) {
		return null
	}
	if (filterFathomRemoveChildNullSentryEvent(event) === null) {
		return null
	}
	if (
		filterChromeExtensionObjectNotFoundSentryEvent(event, originalException) ===
		null
	) {
		return null
	}
	return event
}
