import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers'
import { NonRetryableError } from 'cloudflare:workflows'

import { runBackupRuntime, type BackupRuntimeStep } from './backup-runtime.ts'
import { BackupError } from './backup-policy.ts'
import { type BackupEnvironment, type BackupPayload } from './backup-types.ts'

export class ProductionD1BackupWorkflow extends WorkflowEntrypoint<
	BackupEnvironment,
	BackupPayload
> {
	override async run(
		event: Readonly<WorkflowEvent<BackupPayload>>,
		step: WorkflowStep,
	) {
		try {
			return await runBackupRuntime(
				this.env,
				event,
				step as unknown as BackupRuntimeStep,
			)
		} catch (error) {
			if (error instanceof BackupError && !error.retryable) {
				throw new NonRetryableError(error.message, error.code)
			}
			throw error
		}
	}
}
