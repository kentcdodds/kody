import { expect, test, vi } from 'vitest'
import {
	d1LockRetryBaseDelayMs,
	isRetryableD1LockError,
	isRetryableD1LockMessage,
	runD1WithRetry,
} from './d1-retry.ts'

// KODY-81: live Cloudflare `reference =` tokens include `_`.
const underscoredD1InternalErrorReference =
	'e_Gz3hrU_5c47162d21d24e238a5c25e98b89ee39'

test('runD1WithRetry matches lock errors, retries them, and rethrows other failures immediately', async () => {
	const internalErrorRef = `D1_ERROR: internal error; reference = ${underscoredD1InternalErrorReference}`
	const doReset =
		'D1_ERROR: Internal error in Durable Object storage caused object to be reset'
	// [message, retryable, check via Error (true) or raw message (false)]
	const cases: Array<[string, boolean, boolean]> = [
		['D1_ERROR: NOSENTRY database is locked: SQLITE_BUSY', true, true],
		['Currently processing a long-running export.', true, true],
		['Network connection lost.', true, true],
		[
			'D1_ERROR: D1 DB is overloaded. Requests queued for too long.',
			true,
			true,
		],
		['D1 DB is overloaded. Requests queued for too long', true, true],
		['D1_ERROR: D1 DB is overloaded. Too many requests queued.', true, true],
		['D1 DB is overloaded. Too many requests queued', true, true],
		[
			'D1_ERROR: internal error; reference = 0u3odos5iotccpol68ppc0eg',
			true,
			true,
		],
		[internalErrorRef, true, false],
		[`Error: ${internalErrorRef}`, true, false],
		[internalErrorRef, true, true],
		[
			'D1_ERROR: internal error; reference = e-Gz3hrU-5c47162d21d24e238a5c25e98b89ee39',
			true,
			false,
		],
		[
			'Internal error in D1 DB storage caused object to be reset; reference = 8t4dqqpoq1ctvjr8kca8fl4c',
			true,
			true,
		],
		[
			'Internal error in D1 DB storage caused object to be reset; reference = 8t4d_qqpo-q1ctvjr8kca8fl4c',
			true,
			false,
		],
		// KODY-82: D1 can surface DO-storage object-reset under D1_ERROR:.
		[`${doReset}; reference = b44vvje0qcq0ubd9ea522366`, true, false],
		[`Error: ${doReset}; reference = b44vvje0qcq0ubd9ea522366`, true, true],
		['Network connection lost while uploading...', false, true],
		['queue is overloaded while uploading...', false, true],
		['internal error', false, false],
		['internal error', false, true],
		[
			'Error: D1_ERROR: internal error while writing mcp_agent_sessions',
			false,
			false,
		],
		[
			'D1_ERROR: Internal error in D1 DB storage caused object to be reset',
			false,
			true,
		],
		[doReset, false, false],
		['syntax error near SELECT', false, true],
	]
	expect(
		cases.filter(
			([message, want, asError]) =>
				(asError
					? isRetryableD1LockError(new Error(message))
					: isRetryableD1LockMessage(message)) !== want,
		),
	).toEqual([])

	const successOperation = vi.fn(async () => 'ok')
	await expect(runD1WithRetry(successOperation)).resolves.toBe('ok')
	expect(successOperation).toHaveBeenCalledTimes(1)

	const retryOperation = vi
		.fn()
		.mockRejectedValueOnce(
			new Error('D1_ERROR: NOSENTRY database is locked: SQLITE_BUSY'),
		)
		.mockResolvedValueOnce('ok')
	vi.useFakeTimers()
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
