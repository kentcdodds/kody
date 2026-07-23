import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { runFreshnessAndRetry } from './freshness-retry.ts'

test('backup retry runs when freshness fails', async () => {
	const retryBackup = vi.fn(async () => undefined)
	const freshnessError = new Error('D1 metadata unavailable')
	await assert.rejects(
		runFreshnessAndRetry({
			checkFreshness: async () => {
				throw freshnessError
			},
			retryBackup,
		}),
		(error: unknown) => error === freshnessError,
	)
	assert.equal(retryBackup.mock.calls.length, 1)
})

test('freshness runs when backup retry fails', async () => {
	const checkFreshness = vi.fn(async () => true)
	const retryError = new Error('Workflow API unavailable')
	await assert.rejects(
		runFreshnessAndRetry({
			checkFreshness,
			retryBackup: async () => {
				throw retryError
			},
		}),
		(error: unknown) => error === retryError,
	)
	assert.equal(checkFreshness.mock.calls.length, 1)
})

test('both failures are reported after both lanes run', async () => {
	const freshnessError = new Error('freshness failed')
	const retryError = new Error('retry failed')
	await assert.rejects(
		runFreshnessAndRetry({
			checkFreshness: async () => {
				throw freshnessError
			},
			retryBackup: async () => {
				throw retryError
			},
		}),
		(error: unknown) =>
			error instanceof AggregateError &&
			error.errors[0] === freshnessError &&
			error.errors[1] === retryError,
	)
})
