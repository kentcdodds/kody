import { expect, test, vi } from 'vitest'
import {
	d1LockRetryBaseDelayMs,
	isRetryableD1LockError,
	runD1WithRetry,
} from './d1-retry.ts'

test('runD1WithRetry matches lock errors, retries them, and rethrows other failures immediately', async () => {
	expect(
		isRetryableD1LockError(
			new Error('D1_ERROR: NOSENTRY database is locked: SQLITE_BUSY'),
		),
	).toBe(true)
	expect(isRetryableD1LockError(new Error('database is locked'))).toBe(true)
	expect(isRetryableD1LockError(new Error('syntax error near SELECT'))).toBe(
		false,
	)

	const successOperation = vi.fn(async () => 'ok')
	await expect(runD1WithRetry(successOperation)).resolves.toBe('ok')
	expect(successOperation).toHaveBeenCalledTimes(1)

	vi.useFakeTimers()
	const retryOperation = vi
		.fn()
		.mockRejectedValueOnce(
			new Error('D1_ERROR: NOSENTRY database is locked: SQLITE_BUSY'),
		)
		.mockResolvedValueOnce('ok')
	try {
		const resultPromise = runD1WithRetry(retryOperation)
		await vi.advanceTimersByTimeAsync(d1LockRetryBaseDelayMs)
		await expect(resultPromise).resolves.toBe('ok')
		expect(retryOperation).toHaveBeenCalledTimes(2)
	} finally {
		vi.useRealTimers()
	}

	const failingOperation = vi
		.fn()
		.mockRejectedValue(new Error('D1_ERROR: syntax error near INSERTZ'))
	await expect(runD1WithRetry(failingOperation)).rejects.toThrow('syntax error')
	expect(failingOperation).toHaveBeenCalledTimes(1)
})
