import { errorCauseChainIncludes } from '@kody-internal/shared/error-message.ts'

export const d1LockRetryMaxAttempts = 6

export const d1LockRetryBaseDelayMs = 150

function sleep(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

export function isRetryableD1LockError(error: unknown) {
	return errorCauseChainIncludes(
		error,
		(message) =>
			message.includes('SQLITE_BUSY') || message.includes('database is locked'),
	)
}

/**
 * Retries transient D1 lock contention (SQLITE_BUSY). D1 does not
 * automatically retry write queries, so cron lanes and long-running
 * retention batches need application-level backoff when they overlap
 * with concurrent writers.
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
