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
			return await step.do('run-production-restore', async () =>
				runProductionRestore(this.env, event.payload),
			)
		} catch (error) {
			if (error instanceof BackupError && !error.retryable) {
				throw new NonRetryableError(error.message, error.code)
			}
			throw error
		}
	}
}
