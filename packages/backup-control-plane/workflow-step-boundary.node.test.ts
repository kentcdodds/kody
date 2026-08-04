import assert from 'node:assert/strict'

import { test } from 'vitest'

import { type BackupRuntimeStep } from './backup-runtime.ts'
import {
	BackupError,
	errorCode,
	workflowBackupErrorMessage,
} from './backup-policy.ts'
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
		_name: string,
		configOrCallback: unknown,
		callback?: () => Promise<T>,
	): Promise<T> {
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

function testNonRetryableError(error: BackupError): TestNonRetryableError {
	return new TestNonRetryableError(workflowBackupErrorMessage(error))
}

test('Workflow step boundary fails fast for non-retryable errors and retries transient ones', async () => {
	const nonRetryEngine = new RetryingWorkflowStep()
	const nonRetryStep = withNonRetryableBackupErrors(
		nonRetryEngine,
		testNonRetryableError,
	)

	await assert.rejects(
		nonRetryStep.do('non-retryable', { retries: { limit: 3 } }, async () => {
			throw new BackupError('invalid-workflow-payload', 'invalid payload')
		}),
		(error: unknown) =>
			error instanceof TestNonRetryableError &&
			errorCode(error) === 'invalid-workflow-payload',
	)
	assert.equal(nonRetryEngine.attempts, 1)

	for (const retryableError of [
		new BackupError('d1-export-transient', 'try again', true),
		new Error('temporary network error'),
	]) {
		const engineStep = new RetryingWorkflowStep()
		const step = withNonRetryableBackupErrors(engineStep, testNonRetryableError)
		let callbacks = 0
		const result = await step.do(
			'retryable',
			{ retries: { limit: 2 } },
			async () => {
				callbacks += 1
				if (callbacks === 1) throw retryableError
				return 'complete'
			},
		)
		assert.equal(result, 'complete')
		assert.equal(engineStep.attempts, 2)
	}
})
