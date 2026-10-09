/**
 * Coordinates Sentry captures between SSR `onError` and `handleRequest`.
 * Pre-first-chunk SSR failures are reported in the render callback, then the
 * same error rejects `openDocumentStream` and reaches the app-router catch.
 * Marking here keeps one capture attempt per failure without test-only seams.
 */
const sentryReportedErrors = new WeakSet<object>()

export function markSentryReported(error: unknown) {
	if (typeof error === 'object' && error !== null) {
		sentryReportedErrors.add(error)
	}
}

export function wasSentryReported(error: unknown) {
	return (
		typeof error === 'object' &&
		error !== null &&
		sentryReportedErrors.has(error)
	)
}
