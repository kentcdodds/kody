import assert from 'node:assert/strict'

import { test, vi } from 'vitest'

import { type BackupRuntimeStep } from './backup-runtime.ts'
import { BackupError, workflowBackupErrorMessage } from './backup-policy.ts'
import { environment } from './backup-control-plane-test-support.ts'
import {
	completeSealDay,
	describeSealStatus,
	runSealDay,
	sealDayStepName,
	sealStatusResponseStatus,
} from './seal-day-run.ts'
import { withNonRetryableBackupErrors } from './workflow-step-boundary.ts'

class TestNonRetryableError extends Error {}

class RetryingWorkflowStep implements BackupRuntimeStep {
	attempts = 0

	async do<T>(
		name: string,
		config: unknown,
		callback: () => Promise<T>,
	): Promise<T>
	async do<T>(name: string, callback: () => Promise<T>): Promise<T>
	async do<T>(
		name: string,
		configOrCallback: unknown,
		callback?: () => Promise<T>,
	): Promise<T> {
		assert.equal(name, sealDayStepName)
		const execute =
			typeof configOrCallback === 'function'
				? (configOrCallback as () => Promise<T>)
				: callback!
		const retryLimit =
			typeof configOrCallback === 'object' &&
			configOrCallback !== null &&
			'retries' in configOrCallback
				? Number(
						(configOrCallback as { retries: { limit: number } }).retries.limit,
					)
				: 0
		for (let attempt = 0; ; attempt += 1) {
			this.attempts += 1
			try {
				return await execute()
			} catch (error) {
				if (error instanceof TestNonRetryableError || attempt >= retryLimit) {
					throw error
				}
			}
		}
	}

	async sleep(): Promise<void> {}
}

test('seal workflow step returns a sealed day and does not retry an incomplete day', async () => {
	const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
	const env = environment()
	const day = '2026-09-22'
	const engine = new RetryingWorkflowStep()
	const step = withNonRetryableBackupErrors(engine, (error) => {
		return new TestNonRetryableError(workflowBackupErrorMessage(error))
	})

	const sealed = await runSealDay(env, day, step, async () => ({
		kind: 'sealed',
		day,
		manifestKey: `daily/full/${day}/manifest.json`,
		alreadySealed: true,
	}))
	assert.equal(sealed.alreadySealed, true)
	assert.equal(engine.attempts, 1)

	const fresh = await completeSealDay(env, day, async () => ({
		kind: 'sealed',
		day,
		manifestKey: `daily/full/${day}/manifest.json`,
		alreadySealed: false,
	}))
	assert.equal(fresh.alreadySealed, false)

	engine.attempts = 0
	await assert.rejects(
		runSealDay(env, day, step),
		(error: unknown) =>
			error instanceof TestNonRetryableError &&
			error.message ===
				'[d1-manifest-missing] Day 2026-09-22 is not ready to seal (d1-manifest-missing).',
	)
	assert.equal(engine.attempts, 1)
	const failureLogs = consoleError.mock.calls.map(
		(call) =>
			JSON.parse(String(call[0])) as {
				event: string
				status: string
				errorCode: string
			},
	)
	const operatorFailure = failureLogs.find((log) => log.event === 'ui-seal-day')
	assert.equal(operatorFailure?.status, 'failure')
	assert.equal(operatorFailure?.errorCode, 'd1-manifest-missing')

	await assert.rejects(
		completeSealDay(env, 'not-a-day', async () => {
			throw new Error('seal should not run')
		}),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'invalid-day' &&
			error.retryable === false,
	)

	const incomplete = describeSealStatus({
		status: 'errored',
		error: {
			message:
				'[staging-summary-missing] Day 2026-09-22 is not ready to seal (staging-summary-missing).',
		},
	})
	assert.deepEqual(incomplete, {
		kind: 'incomplete',
		reason: 'staging-summary-missing',
	})
	assert.equal(sealStatusResponseStatus(incomplete), 409)

	const alreadySealed = describeSealStatus({
		status: 'complete',
		output: {
			kind: 'sealed',
			day,
			manifestKey: `daily/full/${day}/manifest.json`,
			alreadySealed: true,
		},
	})
	assert.deepEqual(alreadySealed, {
		kind: 'sealed',
		manifestKey: `daily/full/${day}/manifest.json`,
		alreadySealed: true,
	})
	assert.equal(sealStatusResponseStatus(alreadySealed), 200)
	assert.deepEqual(describeSealStatus({ status: 'running' }), {
		kind: 'pending',
		status: 'running',
	})
})
