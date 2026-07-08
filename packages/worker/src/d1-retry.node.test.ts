import { expect, test, vi } from 'vitest'
import {
	d1LockRetryBaseDelayMs,
	isRetryableD1LockError,
	runD1WithRetry,
} from './d1-retry.ts'

test('isRetryableD1LockError matches SQLITE_BUSY and database is locked', () => {
	expect(
		isRetryableD1LockError(
			new Error('D1_ERROR: NOSENTRY database is locked: SQLITE_BUSY'),
		),
	).toBe(true)
	expect(isRetryableD1LockError(new Error('database is locked'))).toBe(true)
	expect(isRetryableD1LockError(new Error('syntax error near SELECT'))).toBe(
		false,
	)
})

test('runD1WithRetry succeeds on the first attempt', async () => {
	const operation = vi.fn(async () => 'ok')
	await expect(runD1WithRetry(operation)).resolves.toBe('ok')
	expect(operation).toHaveBeenCalledTimes(1)
})

test('runD1WithRetry retries lock contention and eventually succeeds', async () => {
	vi.useFakeTimers()
	const operation = vi
		.fn()
		.mockRejectedValueOnce(
			new Error('D1_ERROR: NOSENTRY database is locked: SQLITE_BUSY'),
		)
		.mockResolvedValueOnce('ok')
	try {
		const resultPromise = runD1WithRetry(operation)
		await vi.advanceTimersByTimeAsync(d1LockRetryBaseDelayMs)
		await expect(resultPromise).resolves.toBe('ok')
		expect(operation).toHaveBeenCalledTimes(2)
	} finally {
		vi.useRealTimers()
	}
})

test('runD1WithRetry rethrows non-lock errors immediately', async () => {
	const operation = vi
		.fn()
		.mockRejectedValue(new Error('D1_ERROR: syntax error near INSERTZ'))
	await expect(runD1WithRetry(operation)).rejects.toThrow('syntax error')
	expect(operation).toHaveBeenCalledTimes(1)
})
