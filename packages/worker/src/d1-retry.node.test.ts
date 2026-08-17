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
	expect(
		isRetryableD1LockError(
			new Error('Currently processing a long-running export.'),
		),
	).toBe(true)
	expect(isRetryableD1LockError(new Error('Network connection lost.'))).toBe(
		true,
	)
	expect(
		isRetryableD1LockError(
			new Error('D1_ERROR: D1 DB is overloaded. Requests queued for too long.'),
		),
	).toBe(true)
	expect(
		isRetryableD1LockError(
			new Error('D1 DB is overloaded. Requests queued for too long'),
		),
	).toBe(true)
	expect(
		isRetryableD1LockError(
			new Error(
				'D1_ERROR: internal error; reference = 0u3odos5iotccpol68ppc0eg',
			),
		),
	).toBe(true)
	expect(
		isRetryableD1LockError(
			new Error(
				'Internal error in D1 DB storage caused object to be reset; reference = 8t4dqqpoq1ctvjr8kca8fl4c',
			),
		),
	).toBe(true)
	expect(
		isRetryableD1LockError(
			new Error('Network connection lost while uploading...'),
		),
	).toBe(false)
	expect(
		isRetryableD1LockError(new Error('queue is overloaded while uploading...')),
	).toBe(false)
	expect(isRetryableD1LockError(new Error('internal error'))).toBe(false)
	expect(
		isRetryableD1LockError(
			new Error(
				'D1_ERROR: Internal error in D1 DB storage caused object to be reset',
			),
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

	const failingOperation = vi
		.fn()
		.mockRejectedValue(new Error('D1_ERROR: syntax error near INSERTZ'))
	await expect(runD1WithRetry(failingOperation)).rejects.toThrow('syntax error')
	expect(failingOperation).toHaveBeenCalledTimes(1)
})

test('runD1WithRetry retries hung attempts when attemptTimeoutMs is set', async () => {
	let attempts = 0
	const hungThenOk = vi.fn(async () => {
		attempts += 1
		if (attempts === 1) {
			await new Promise(() => {})
		}
		return 'ok'
	})
	await expect(
		runD1WithRetry(hungThenOk, {
			maxAttempts: 3,
			attemptTimeoutMs: 20,
			baseDelayMs: 1,
		}),
	).resolves.toBe('ok')
	expect(hungThenOk).toHaveBeenCalledTimes(2)

	const alwaysHung = vi.fn(async () => {
		await new Promise(() => {})
		return 'ok'
	})
	await expect(
		runD1WithRetry(alwaysHung, {
			maxAttempts: 2,
			attemptTimeoutMs: 15,
			baseDelayMs: 1,
		}),
	).rejects.toThrow('D1 attempt timed out after 15ms')
	expect(alwaysHung).toHaveBeenCalledTimes(2)
})
