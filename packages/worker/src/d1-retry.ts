import { type ErrorEvent } from '@sentry/core'
import { isRetryableD1LockMessage } from '@kody-internal/shared/d1-retry.ts'

export * from '@kody-internal/shared/d1-retry.ts'

export function isRetryableD1LockSentryEvent(event: ErrorEvent) {
	const messages = [
		event.message,
		...(event.exception?.values?.map((value) => value.value) ?? []),
	]
	return messages.some(
		(message) =>
			typeof message === 'string' && isRetryableD1LockMessage(message),
	)
}
