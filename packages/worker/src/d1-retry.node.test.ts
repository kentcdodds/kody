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
	expect(
		isRetryableD1LockError(
			new Error('D1_ERROR: Currently processing a long-running export.'),
		),
	).toBe(true)
	expect(
		isRetryableD1LockError(
			new Error('Currently processing a long-running export.'),
		),
	).toBe(true)
	expect(
		isRetryableD1LockError(new Error('D1_ERROR: Network connection lost.')),
	).toBe(true)
	expect(isRetryableD1LockError(new Error('Network connection lost.'))).toBe(
		true,
	)
	expect(
		isRetryableD1LockError(new Error('Error: Network connection lost.')),
	).toBe(true)
	expect(
		isRetryableD1LockError(
			new Error('Network connection lost while uploading...'),
		),
	).toBe(false)
	expect(
		isRetryableD1LockError(
			new Error(
				'D1_ERROR: internal error; reference = 0u3odos5iotccpol68ppc0eg',
			),
		),
	).toBe(true)
	expect(
		isRetryableD1LockError(
			new Error('internal error; reference = 0u3odos5iotccpol68ppc0eg'),
		),
	).toBe(true)
	expect(isRetryableD1LockError(new Error('internal error'))).toBe(false)
	expect(
		isRetryableD1LockError(
			new Error('D1_ERROR: internal error while applying migration'),
		),
	).toBe(false)
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

	vi.useFakeTimers()
	const exportRetryOperation = vi
		.fn()
		.mockRejectedValueOnce(
			new Error('D1_ERROR: Currently processing a long-running export.'),
		)
		.mockResolvedValueOnce('ok')
	try {
		const resultPromise = runD1WithRetry(exportRetryOperation)
		await vi.advanceTimersByTimeAsync(d1LockRetryBaseDelayMs)
		await expect(resultPromise).resolves.toBe('ok')
		expect(exportRetryOperation).toHaveBeenCalledTimes(2)
	} finally {
		vi.useRealTimers()
	}

	vi.useFakeTimers()
	const networkRetryOperation = vi
		.fn()
		.mockRejectedValueOnce(new Error('D1_ERROR: Network connection lost.'))
		.mockResolvedValueOnce('ok')
	try {
		const resultPromise = runD1WithRetry(networkRetryOperation)
		await vi.advanceTimersByTimeAsync(d1LockRetryBaseDelayMs)
		await expect(resultPromise).resolves.toBe('ok')
		expect(networkRetryOperation).toHaveBeenCalledTimes(2)
	} finally {
		vi.useRealTimers()
	}

	vi.useFakeTimers()
	const internalErrorRetryOperation = vi
		.fn()
		.mockRejectedValueOnce(
			new Error(
				'D1_ERROR: internal error; reference = 0u3odos5iotccpol68ppc0eg',
			),
		)
		.mockResolvedValueOnce('ok')
	try {
		const resultPromise = runD1WithRetry(internalErrorRetryOperation)
		await vi.advanceTimersByTimeAsync(d1LockRetryBaseDelayMs)
		await expect(resultPromise).resolves.toBe('ok')
		expect(internalErrorRetryOperation).toHaveBeenCalledTimes(2)
	} finally {
		vi.useRealTimers()
	}

	const failingOperation = vi
		.fn()
		.mockRejectedValue(new Error('D1_ERROR: syntax error near INSERTZ'))
	await expect(runD1WithRetry(failingOperation)).rejects.toThrow('syntax error')
	expect(failingOperation).toHaveBeenCalledTimes(1)
})
