import { errorCauseChainIncludes } from './error-message.ts'

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

/**
 * Cloudflare D1 capacity blip
 * (`D1_ERROR: D1 DB is overloaded. Requests queued for too long.`).
 * Not an application defect — D1's request queue timed out under platform
 * load. Same retry / Sentry-drop class as SQLITE_BUSY and binding transport
 * blips. Match only the exact D1 forms (optional `Error:` / `D1_ERROR:`
 * prefixes) so unrelated "… overloaded …" messages stay out.
 */
export const d1DbOverloadedMessage =
	'D1 DB is overloaded. Requests queued for too long'

/**
 * Cloudflare D1 opaque platform failures with a support reference, e.g.
 * `D1_ERROR: internal error; reference = <id>` and
 * `D1_ERROR: Internal error in D1 DB storage caused object to be reset; reference = <id>`.
 * Not an application defect — D1's storage/backend hit an internal fault.
 * Same retry / Sentry-drop class as SQLITE_BUSY and binding transport blips.
 * Require the `reference =` token and only these known D1 phrasings so bare
 * "internal error" (or unrelated "internal error while …") from app code
 * stays non-retryable and Sentry-visible.
 */
const d1InternalErrorReferencePattern =
	/^internal error(?: in D1 DB storage caused object to be reset)?;\s*reference\s*=\s*[A-Za-z0-9]+$/i

function stripD1ErrorPrefixes(message: string) {
	return message
		.trim()
		.replace(/^Error:\s*/i, '')
		.replace(/^D1_ERROR:\s*/i, '')
}

function isExactD1PlatformMessage(message: string, expected: string) {
	const normalized = stripD1ErrorPrefixes(message)
	return normalized === expected || normalized === `${expected}.`
}

function isD1NetworkConnectionLostMessage(message: string) {
	return isExactD1PlatformMessage(message, d1NetworkConnectionLostMessage)
}

function isD1DbOverloadedMessage(message: string) {
	return isExactD1PlatformMessage(message, d1DbOverloadedMessage)
}

function isD1InternalErrorMessage(message: string) {
	return d1InternalErrorReferencePattern.test(stripD1ErrorPrefixes(message))
}

export function isRetryableD1LockMessage(message: string) {
	return (
		message.includes('SQLITE_BUSY') ||
		message.includes('database is locked') ||
		message.includes(d1LongRunningExportMessage) ||
		isD1NetworkConnectionLostMessage(message) ||
		isD1DbOverloadedMessage(message) ||
		isD1InternalErrorMessage(message)
	)
}

export function isRetryableD1LockError(error: unknown) {
	return errorCauseChainIncludes(error, isRetryableD1LockMessage)
}

/**
 * Opt-in per-attempt deadline for `runD1WithRetry`. Idle D1 bindings can hang
 * instead of throwing a retryable platform error; a bounded attempt lets the
 * next try run before an outer health-check timeout fires.
 */
export class D1AttemptTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`D1 attempt timed out after ${timeoutMs}ms`)
		this.name = 'D1AttemptTimeoutError'
	}
}

function isD1AttemptTimeoutError(error: unknown) {
	return error instanceof D1AttemptTimeoutError
}

function withAttemptTimeout<T>(
	operation: Promise<T>,
	timeoutMs: number,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const handle = setTimeout(() => {
			reject(new D1AttemptTimeoutError(timeoutMs))
		}, timeoutMs)
		operation.then(
			(value) => {
				clearTimeout(handle)
				resolve(value)
			},
			(error: unknown) => {
				clearTimeout(handle)
				reject(error)
			},
		)
	})
}

/**
 * Retries transient D1 unavailability: SQLITE_BUSY lock contention,
 * Cloudflare's "Currently processing a long-running export" (DR / REST
 * exports block other requests), binding "Network connection lost"
 * transport blips, "D1 DB is overloaded. Requests queued for too long"
 * capacity blips, and opaque D1 "internal error …; reference = …" platform
 * faults (including storage object-reset). D1 does not automatically retry
 * write queries, so cron lanes and long-running retention batches need
 * application-level backoff when they overlap with concurrent writers, an
 * in-flight export, a brief D1 session drop, a D1 capacity spike, or a D1
 * backend blip.
 *
 * When `attemptTimeoutMs` is set, a hung attempt is also retried so a single
 * idle-database stall cannot consume an outer deadline.
 */
export async function runD1WithRetry<T>(
	operation: () => Promise<T>,
	options?: {
		maxAttempts?: number
		baseDelayMs?: number
		attemptTimeoutMs?: number
	},
): Promise<T> {
	const maxAttempts = options?.maxAttempts ?? d1LockRetryMaxAttempts
	const baseDelayMs = options?.baseDelayMs ?? d1LockRetryBaseDelayMs
	const attemptTimeoutMs = options?.attemptTimeoutMs
	let lastError: unknown
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const result = operation()
			return attemptTimeoutMs === undefined
				? await result
				: await withAttemptTimeout(result, attemptTimeoutMs)
		} catch (error) {
			lastError = error
			const retryable =
				isRetryableD1LockError(error) ||
				(attemptTimeoutMs !== undefined && isD1AttemptTimeoutError(error))
			if (!retryable || attempt === maxAttempts) {
				throw error
			}
			await sleep(baseDelayMs * 2 ** (attempt - 1))
		}
	}
	throw lastError
}
