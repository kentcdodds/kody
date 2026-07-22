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
import {
	enqueueBackup,
	isApprovedRetryWindow,
	retryExistingBackup,
	type EnqueueResult,
} from './workflow-trigger.ts'

export { ProductionD1BackupWorkflow } from './backup-workflow.ts'

export const BACKUP_CRON = '15 2 * * *'
export const FRESHNESS_CRON = '45 * * * *'

function enqueueEvent(
	result: EnqueueResult,
): 'backup-enqueued' | 'backup-overlap' | 'backup-restarted' {
	switch (result) {
		case 'created':
			return 'backup-enqueued'
		case 'duplicate':
			return 'backup-overlap'
		case 'restarted':
			return 'backup-restarted'
		default: {
			const exhaustive: never = result
			throw exhaustive
		}
	}
}

async function triggerBackup(
	env: BackupEnvironment,
	scheduledAt: Date,
): Promise<void> {
	const payload = backupPayload(env, scheduledAt)
	const instanceId = workflowInstanceId(env.SOURCE_DATABASE_ID, payload.day)
	const result = await enqueueBackup(
		env.BACKUP_WORKFLOW,
		env.SOURCE_DATABASE_ID,
		payload,
	)
	safeLog({
		event: enqueueEvent(result),
		status: 'success',
		day: payload.day,
		instanceId,
		manifestKey: payload.manifestKey,
	})
}

async function retryExisting(
	env: BackupEnvironment,
	scheduledAt: Date,
): Promise<void> {
	const payload = backupPayload(env, scheduledAt)
	const result = await retryExistingBackup(
		env.BACKUP_WORKFLOW,
		env.SOURCE_DATABASE_ID,
		payload.day,
	)
	switch (result) {
		case 'missing':
		case 'duplicate':
			return
		case 'restarted':
			safeLog({
				event: 'backup-restarted',
				status: 'success',
				day: payload.day,
				instanceId: workflowInstanceId(env.SOURCE_DATABASE_ID, payload.day),
				manifestKey: payload.manifestKey,
			})
			return
		default: {
			const exhaustive: never = result
			throw exhaustive
		}
	}
}

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
		case BACKUP_CRON:
			await triggerBackup(env, scheduledAt)
			return
		case FRESHNESS_CRON:
			await checkFreshness(env, scheduledAt)
			if (isApprovedRetryWindow(scheduledAt)) {
				await retryExisting(env, scheduledAt)
			}
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
