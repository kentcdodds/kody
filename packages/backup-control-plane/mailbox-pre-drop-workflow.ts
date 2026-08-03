import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers'
import { NonRetryableError } from 'cloudflare:workflows'

import { type BackupRuntimeStep } from './backup-runtime.ts'
import { BackupError } from './backup-policy.ts'
import {
	type BackupEnvironment,
	type MailboxPreDropBackupRequest,
} from './backup-types.ts'
import { runMailboxLegacyGraphPreDropBackup } from './mailbox-pre-drop-runtime.ts'

export class MailboxLegacyGraphPreDropBackupWorkflow extends WorkflowEntrypoint<
	BackupEnvironment,
	MailboxPreDropBackupRequest
> {
	override async run(
		event: Readonly<WorkflowEvent<MailboxPreDropBackupRequest>>,
		step: WorkflowStep,
	) {
		try {
			return await runMailboxLegacyGraphPreDropBackup(
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
