import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers'
import { NonRetryableError } from 'cloudflare:workflows'

import { type BackupRuntimeStep } from './backup-runtime.ts'
import { BackupError, workflowBackupErrorMessage } from './backup-policy.ts'
import { type BackupEnvironment } from './backup-types.ts'
import {
	runProductionRestore,
	type ProductionRestorePayload,
	type ProductionRestoreProgress,
} from './production-restore.ts'
import { withNonRetryableBackupErrors } from './workflow-step-boundary.ts'

function nonRetryableBackupError(error: BackupError): NonRetryableError {
	return new NonRetryableError(workflowBackupErrorMessage(error), error.code)
}

export class ProductionDrRestoreWorkflow extends WorkflowEntrypoint<
	BackupEnvironment,
	ProductionRestorePayload
> {
	override async run(
		event: Readonly<WorkflowEvent<ProductionRestorePayload>>,
		step: WorkflowStep,
	): Promise<ProductionRestoreProgress> {
		try {
			const runtimeStep = withNonRetryableBackupErrors(
				step as unknown as BackupRuntimeStep,
				nonRetryableBackupError,
			)
			const progress = await runtimeStep.do(
				'run-production-restore',
				async () => runProductionRestore(this.env, event.payload),
			)
			// Persist progress (including warnings) as step output, then fail the
			// workflow instance when restore finished with any dr-restore warnings.
			if (progress.phase === 'failed' || progress.warnings.length > 0) {
				const code = progress.errorCode ?? 'dr-restore-warnings'
				throw new NonRetryableError(
					workflowBackupErrorMessage({
						code,
						message:
							progress.errorMessage ??
							'production restore completed with warnings',
					}),
					code,
				)
			}
			return progress
		} catch (error) {
			if (error instanceof BackupError && !error.retryable) {
				throw nonRetryableBackupError(error)
			}
			throw error
		}
	}
}
