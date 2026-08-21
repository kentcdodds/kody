import { expect, test, vi } from 'vitest'
import {
	durableObjectCodeUpdatedResetMessage,
	durableObjectInstanceInactiveCloseMessage,
} from '#worker/sentry-options.ts'
import {
	isTransientDurableObjectResetError,
	runWithTransientDurableObjectResetRetry,
} from './durable-object-reset-retry.ts'

test('transient Durable Object reset retry recovers thrown and result errors then exhausts', async () => {
	expect(
		isTransientDurableObjectResetError(
			new Error(durableObjectCodeUpdatedResetMessage),
		),
	).toBe(true)
	expect(
		isTransientDurableObjectResetError(durableObjectCodeUpdatedResetMessage),
	).toBe(true)
	expect(
		isTransientDurableObjectResetError(
			new Error('wrapped', {
				cause: new Error(durableObjectCodeUpdatedResetMessage),
			}),
		),
	).toBe(true)
	expect(
		isTransientDurableObjectResetError(
			durableObjectInstanceInactiveCloseMessage,
		),
	).toBe(true)
	expect(
		isTransientDurableObjectResetError(
			new Error(durableObjectInstanceInactiveCloseMessage),
		),
	).toBe(true)
	expect(
		isTransientDurableObjectResetError(new Error('user code failed')),
	).toBe(false)

	vi.useFakeTimers()
	try {
		const thrownThenOk = vi
			.fn<() => Promise<{ ok: boolean }>>()
			.mockRejectedValueOnce(new Error(durableObjectCodeUpdatedResetMessage))
			.mockResolvedValueOnce({ ok: true })
		const retries: Array<{ attempt: number; nextDelayMs: number }> = []
		const thrownPending = runWithTransientDurableObjectResetRetry({
			operation: thrownThenOk,
			onRetry: ({ attempt, nextDelayMs }) => {
				retries.push({ attempt, nextDelayMs })
			},
		})
		await vi.runAllTimersAsync()
		await expect(thrownPending).resolves.toEqual({ ok: true })
		expect(thrownThenOk).toHaveBeenCalledTimes(2)
		expect(retries).toEqual([{ attempt: 1, nextDelayMs: 100 }])

		const resultThenOk = vi
			.fn<() => Promise<{ error?: string; result?: string }>>()
			.mockResolvedValueOnce({
				error: durableObjectCodeUpdatedResetMessage,
			})
			.mockResolvedValueOnce({ result: 'recovered' })
		const resultPending = runWithTransientDurableObjectResetRetry({
			operation: resultThenOk,
			retryableResultError: (value) =>
				typeof value === 'object' &&
				value &&
				'error' in value &&
				typeof value.error === 'string'
					? value.error
					: null,
		})
		await vi.runAllTimersAsync()
		await expect(resultPending).resolves.toEqual({ result: 'recovered' })
		expect(resultThenOk).toHaveBeenCalledTimes(2)

		const permanent = vi
			.fn<() => Promise<never>>()
			.mockRejectedValue(new Error('user code failed'))
		await expect(
			runWithTransientDurableObjectResetRetry({
				operation: permanent,
			}),
		).rejects.toThrow('user code failed')
		expect(permanent).toHaveBeenCalledTimes(1)

		const exhausted = vi
			.fn<() => Promise<{ error: string }>>()
			.mockResolvedValue({
				error: durableObjectCodeUpdatedResetMessage,
			})
		const exhaustedPending = runWithTransientDurableObjectResetRetry({
			operation: exhausted,
			retryableResultError: (value) =>
				typeof value === 'object' &&
				value &&
				'error' in value &&
				typeof value.error === 'string'
					? value.error
					: null,
		})
		await vi.runAllTimersAsync()
		await expect(exhaustedPending).resolves.toEqual({
			error: durableObjectCodeUpdatedResetMessage,
		})
		expect(exhausted).toHaveBeenCalledTimes(3)

		const dirtyResult = vi
			.fn<() => Promise<{ error: string; dirty: boolean }>>()
			.mockResolvedValue({
				error: durableObjectCodeUpdatedResetMessage,
				dirty: true,
			})
		await expect(
			runWithTransientDurableObjectResetRetry({
				operation: dirtyResult,
				retryableResultError: (value) => value.error,
				shouldRetry: ({ result }) => result?.dirty !== true,
			}),
		).resolves.toEqual({
			error: durableObjectCodeUpdatedResetMessage,
			dirty: true,
		})
		expect(dirtyResult).toHaveBeenCalledTimes(1)

		const dirtyThrown = vi
			.fn<() => Promise<never>>()
			.mockRejectedValue(new Error(durableObjectCodeUpdatedResetMessage))
		await expect(
			runWithTransientDurableObjectResetRetry({
				operation: dirtyThrown,
				shouldRetry: () => false,
			}),
		).rejects.toThrow(durableObjectCodeUpdatedResetMessage)
		expect(dirtyThrown).toHaveBeenCalledTimes(1)

		const exhaustedUndefined = vi
			.fn<() => Promise<undefined>>()
			.mockResolvedValue(undefined)
		const exhaustedUndefinedPending = runWithTransientDurableObjectResetRetry({
			operation: exhaustedUndefined,
			retryableResultError: () => durableObjectCodeUpdatedResetMessage,
		})
		await vi.runAllTimersAsync()
		await expect(exhaustedUndefinedPending).resolves.toBeUndefined()
		expect(exhaustedUndefined).toHaveBeenCalledTimes(3)
	} finally {
		vi.useRealTimers()
	}
})
