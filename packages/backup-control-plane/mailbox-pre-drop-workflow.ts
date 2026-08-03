import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers'
import { NonRetryableError } from 'cloudflare:workflows'

import { type BackupRuntimeStep } from './backup-runtime.ts'
import { BackupError, workflowBackupErrorMessage } from './backup-policy.ts'
import {
	type BackupEnvironment,
	type MailboxPreDropBackupRequest,
} from './backup-types.ts'
import { runMailboxLegacyGraphPreDropBackup } from './mailbox-pre-drop-runtime.ts'
import { withNonRetryableBackupErrors } from './workflow-step-boundary.ts'

function nonRetryableBackupError(error: BackupError): NonRetryableError {
	return new NonRetryableError(workflowBackupErrorMessage(error), error.code)
}

export class MailboxLegacyGraphPreDropBackupWorkflow extends WorkflowEntrypoint<
	BackupEnvironment,
	MailboxPreDropBackupRequest
> {
	override async run(
		event: Readonly<WorkflowEvent<MailboxPreDropBackupRequest>>,
		step: WorkflowStep,
	) {
		try {
			const runtimeStep = withNonRetryableBackupErrors(
				step as unknown as BackupRuntimeStep,
				nonRetryableBackupError,
			)
			return await runMailboxLegacyGraphPreDropBackup(
				this.env,
				event,
				runtimeStep,
			)
		} catch (error) {
			if (error instanceof BackupError && !error.retryable) {
				throw nonRetryableBackupError(error)
			}
			throw error
		}
	}
}
