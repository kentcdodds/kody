import { type ErrorEvent } from '@sentry/core'
import { isRetryableD1LockMessage } from '@kody-internal/shared/d1-retry.ts'

export * from '@kody-internal/shared/d1-retry.ts'

export function isRetryableD1LockSentryEvent(event: ErrorEvent) {
	const messages = [
		event.message,
		...(event.exception?.values?.map((value) => value.value) ?? []),
	].filter(
		(message): message is string =>
			typeof message === 'string' && message.trim().length > 0,
	)
	// Drop only when every reported message is a bare D1 platform blip. A
	// chained cause that pairs a recovery/wrapper value with an inner lock or
	// startup-reset must stay visible (same all-messages rule as DO resets).
	return (
		messages.length > 0 &&
		messages.every((message) => isRetryableD1LockMessage(message))
	)
}
