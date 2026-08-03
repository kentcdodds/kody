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
 * Firefox (including Firefox-for-iOS / WebKit shells) exposes
 * `window.__firefox__` for reader mode and the content bridge. Injected or
 * browser-internal scripts reference it; when the bridge is absent they throw
 * ReferenceError / TypeError that Sentry's global onerror captures as in-app
 * "global code" with no app frames. Kody app source never mentions
 * `__firefox__` (KODY-CLOUDFLARE-3F / 3E).
 *
 * Match only messages that name `__firefox__` with these known wordings —
 * never blanket-drop ReferenceError or TypeError.
 */
const firefoxBridgeNoiseMessage =
	/(?:Can't find variable:\s*__firefox__|__firefox__ is not defined|undefined is not an object \(evaluating ['"]window\.__firefox__|null is not an object \(evaluating ['"]window\.__firefox__)/

export function isFirefoxBridgeNoiseMessage(message: string) {
	return firefoxBridgeNoiseMessage.test(message)
}

export function isFirefoxBridgeNoiseError(error: unknown) {
	if (typeof error !== 'object' || error === null) return false
	if (!('message' in error) || typeof error.message !== 'string') return false
	return isFirefoxBridgeNoiseMessage(error.message)
}

export function isFirefoxBridgeNoiseSentryEvent(
	event: SentryErrorEventLike,
	originalException?: unknown,
) {
	if (isFirefoxBridgeNoiseError(originalException)) return true
	return sentryEventMessages(event).some(
		(message) =>
			typeof message === 'string' && isFirefoxBridgeNoiseMessage(message),
	)
}

export function filterFirefoxBridgeNoiseSentryEvent<
	T extends SentryErrorEventLike,
>(event: T, originalException?: unknown): T | null {
	if (isFirefoxBridgeNoiseSentryEvent(event, originalException)) {
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
	if (filterFirefoxBridgeNoiseSentryEvent(event, originalException) === null) {
		return null
	}
	return event
}
