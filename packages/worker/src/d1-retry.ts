import { type ErrorEvent } from '@sentry/core'
import { isBareRetryableD1LockMessage } from '@kody-internal/shared/d1-retry.ts'

export * from '@kody-internal/shared/d1-retry.ts'

export function isRetryableD1LockSentryEvent(event: ErrorEvent) {
	const messages = [
		event.message,
		...(event.exception?.values?.map((value) => value.value) ?? []),
	].filter(
		(message): message is string =>
			typeof message === 'string' && message.trim().length > 0,
	)
	// Drop only when every reported message is a bare D1 platform blip.
	// Use the anchored/exact predicate (not the substring retry matcher) so
	// rebuild/recovery wrappers that embed SQLITE_BUSY, export, or reset text
	// stay Sentry-visible even when the cause is a matching D1 blip.
	return (
		messages.length > 0 &&
		messages.every((message) => isBareRetryableD1LockMessage(message))
	)
}
