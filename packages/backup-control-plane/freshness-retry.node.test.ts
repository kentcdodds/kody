import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { runFreshnessAndRetry } from './freshness-retry.ts'

test('freshness and retry lanes always both run and surface independent failures', async () => {
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

	const bothFreshnessError = new Error('freshness failed')
	const bothRetryError = new Error('retry failed')
	await assert.rejects(
		runFreshnessAndRetry({
			checkFreshness: async () => {
				throw bothFreshnessError
			},
			retryBackup: async () => {
				throw bothRetryError
			},
		}),
		(error: unknown) =>
			error instanceof AggregateError &&
			error.errors[0] === bothFreshnessError &&
			error.errors[1] === bothRetryError,
	)
})
