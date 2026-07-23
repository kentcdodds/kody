import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers'
import { NonRetryableError } from 'cloudflare:workflows'

import { BackupError } from './backup-policy.ts'
import { type BackupEnvironment } from './backup-types.ts'
import {
	runProductionRestore,
	type ProductionRestorePayload,
	type ProductionRestoreProgress,
} from './production-restore.ts'

export class ProductionDrRestoreWorkflow extends WorkflowEntrypoint<
	BackupEnvironment,
	ProductionRestorePayload
> {
	override async run(
		event: Readonly<WorkflowEvent<ProductionRestorePayload>>,
		step: WorkflowStep,
	): Promise<ProductionRestoreProgress> {
		try {
			const progress = await step.do('run-production-restore', async () =>
				runProductionRestore(this.env, event.payload),
			)
			// Persist progress (including warnings) as step output, then fail the
			// workflow instance when restore finished with any dr-restore warnings.
			if (progress.phase === 'failed' || progress.warnings.length > 0) {
				throw new NonRetryableError(
					progress.errorMessage ?? 'production restore completed with warnings',
					progress.errorCode ?? 'dr-restore-warnings',
				)
			}
			return progress
		} catch (error) {
			if (error instanceof BackupError && !error.retryable) {
				throw new NonRetryableError(error.message, error.code)
			}
			throw error
		}
	}
}
