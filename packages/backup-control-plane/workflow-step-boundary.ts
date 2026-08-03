import { type BackupRuntimeStep } from './backup-runtime.ts'
import { BackupError } from './backup-policy.ts'

type NonRetryableErrorFactory = (error: BackupError) => Error

async function runStepCallback<T>(
	callback: () => Promise<T>,
	createNonRetryableError: NonRetryableErrorFactory,
): Promise<T> {
	try {
		return await callback()
	} catch (error) {
		if (error instanceof BackupError && !error.retryable) {
			throw createNonRetryableError(error)
		}
		throw error
	}
}

export function withNonRetryableBackupErrors(
	step: BackupRuntimeStep,
	createNonRetryableError: NonRetryableErrorFactory,
): BackupRuntimeStep {
	return {
		do<T>(
			name: string,
			configOrCallback: unknown,
			callback?: () => Promise<T>,
		): Promise<T> {
			if (typeof configOrCallback === 'function') {
				return step.do(name, () =>
					runStepCallback(
						configOrCallback as () => Promise<T>,
						createNonRetryableError,
					),
				)
			}
			if (!callback) {
				throw new Error('Workflow step callback is required.')
			}
			return step.do(name, configOrCallback, () =>
				runStepCallback(callback, createNonRetryableError),
			)
		},
		sleep(name, duration) {
			return step.sleep(name, duration)
		},
	}
}
