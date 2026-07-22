import { checkFreshness } from './freshness-check.ts'
import {
	BackupError,
	backupPayload,
	errorCode,
	isBackupEnabled,
	safeLog,
	workflowInstanceId,
} from './backup-policy.ts'
import { type BackupEnvironment } from './backup-types.ts'
import { enqueueBackup } from './workflow-trigger.ts'

export { ProductionD1BackupWorkflow } from './backup-workflow.ts'

export const BACKUP_CRON = '15 2 * * *'
export const FRESHNESS_CRON = '45 * * * *'

async function scheduled(
	controller: ScheduledController,
	env: BackupEnvironment,
): Promise<void> {
	if (!isBackupEnabled(env)) {
		safeLog({
			event: 'backup-disabled',
			status: 'disabled',
			errorCode: 'explicit-enable-or-benchmark-approval-missing',
		})
		return
	}
	const scheduledAt = new Date(controller.scheduledTime)
	switch (controller.cron) {
		case BACKUP_CRON: {
			const payload = backupPayload(env, scheduledAt)
			const instanceId = workflowInstanceId(env.SOURCE_DATABASE_ID, payload.day)
			const result = await enqueueBackup(
				env.BACKUP_WORKFLOW,
				env.SOURCE_DATABASE_ID,
				payload,
			)
			safeLog({
				event: result === 'created' ? 'backup-enqueued' : 'backup-overlap',
				status: 'success',
				day: payload.day,
				instanceId,
				objectKey: payload.objectKey,
				manifestKey: payload.manifestKey,
			})
			return
		}
		case FRESHNESS_CRON:
			await checkFreshness(env, scheduledAt)
			return
		default:
			throw new BackupError(
				'unknown-schedule',
				`unexpected cron trigger: ${controller.cron}`,
			)
	}
}

export default {
	async scheduled(
		controller: ScheduledController,
		env: BackupEnvironment,
	): Promise<void> {
		try {
			await scheduled(controller, env)
		} catch (error) {
			safeLog({
				event: 'backup-failure',
				status: 'failure',
				errorCode: errorCode(error),
			})
			throw error
		}
	},
}
