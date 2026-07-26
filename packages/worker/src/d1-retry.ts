import { errorCauseChainIncludes } from '@kody-internal/shared/error-message.ts'
import { type ErrorEvent } from '@sentry/core'

export const d1LockRetryMaxAttempts = 6

export const d1LockRetryBaseDelayMs = 150

function sleep(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

/**
 * Cloudflare D1 emits this while a REST/API export is in progress. Exports
 * block other database requests for consistency (see D1 import/export docs),
 * so production MCP/cron traffic fails for the duration of the nightly DR
 * backup export. Same class of transient unavailability as SQLITE_BUSY.
 */
export const d1LongRunningExportMessage =
	'Currently processing a long-running export'

/**
 * Cloudflare D1 binding transport blip (`D1_ERROR: Network connection lost.`).
 * Not an application defect — the Worker lost its session to D1 mid-query.
 * Same retry / Sentry-drop class as SQLITE_BUSY and long-running exports.
 * Match only the exact D1 forms (optional `Error:` / `D1_ERROR:` prefixes) so
 * unrelated "Network connection lost while …" messages stay out.
 */
export const d1NetworkConnectionLostMessage = 'Network connection lost'

function isD1NetworkConnectionLostMessage(message: string) {
	const normalized = message
		.trim()
		.replace(/^Error:\s*/i, '')
		.replace(/^D1_ERROR:\s*/i, '')
	return (
		normalized === d1NetworkConnectionLostMessage ||
		normalized === `${d1NetworkConnectionLostMessage}.`
	)
}

export function isRetryableD1LockMessage(message: string) {
	return (
		message.includes('SQLITE_BUSY') ||
		message.includes('database is locked') ||
		message.includes(d1LongRunningExportMessage) ||
		isD1NetworkConnectionLostMessage(message)
	)
}

export function isRetryableD1LockError(error: unknown) {
	return errorCauseChainIncludes(error, isRetryableD1LockMessage)
}

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

/**
 * Retries transient D1 unavailability: SQLITE_BUSY lock contention,
 * Cloudflare's "Currently processing a long-running export" (DR / REST
 * exports block other requests), and binding "Network connection lost"
 * transport blips. D1 does not automatically retry write queries, so cron
 * lanes and long-running retention batches need application-level backoff
 * when they overlap with concurrent writers, an in-flight export, or a
 * brief D1 session drop.
 */
export async function runD1WithRetry<T>(
	operation: () => Promise<T>,
	options?: {
		maxAttempts?: number
		baseDelayMs?: number
	},
): Promise<T> {
	const maxAttempts = options?.maxAttempts ?? d1LockRetryMaxAttempts
	const baseDelayMs = options?.baseDelayMs ?? d1LockRetryBaseDelayMs
	let lastError: unknown
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await operation()
		} catch (error) {
			lastError = error
			if (!isRetryableD1LockError(error) || attempt === maxAttempts) {
				throw error
			}
			await sleep(baseDelayMs * 2 ** (attempt - 1))
		}
	}
	throw lastError
}
