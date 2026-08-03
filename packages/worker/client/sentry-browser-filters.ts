/**
 * Browser Sentry event filters. Kept free of `@sentry/browser` imports so unit
 * tests can exercise the predicates with plain event shapes.
 */

type SentryExceptionValue = {
	type?: string
	value?: string
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
	return event
}
