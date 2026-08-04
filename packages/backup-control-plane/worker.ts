import { checkFreshness } from './freshness-check.ts'
import { runFreshnessAndRetry } from './freshness-retry.ts'
import {
	BackupError,
	backupPayload,
	errorCode,
	isBackupEnabled,
	safeLog,
	workflowInstanceId,
} from './backup-policy.ts'
import { type BackupEnvironment } from './backup-types.ts'
import { handleControlPlaneFetch } from './control-plane-fetch.ts'
import { sealRecentCompleteDays } from './seal-full-backup.ts'
import {
	enqueueBackup,
	enqueueBackupRetry,
	primaryBackupTimeForDay,
	type EnqueueResult,
} from './workflow-trigger.ts'

export { ProductionD1BackupWorkflow } from './backup-workflow.ts'
export { ProductionDrRestoreWorkflow } from './restore-workflow.ts'

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

async function retryBackup(
	env: BackupEnvironment,
	scheduledAt: Date,
): Promise<void> {
	const payload = backupPayload(env, primaryBackupTimeForDay(scheduledAt))
	const result = await enqueueBackupRetry(
		env.BACKUP_WORKFLOW,
		env.SOURCE_DATABASE_ID,
		payload,
		scheduledAt,
	)
	switch (result) {
		case 'outside-window':
		case 'duplicate':
			return
		case 'created':
			safeLog({
				event: 'backup-catch-up-enqueued',
				status: 'success',
				day: payload.day,
				instanceId: workflowInstanceId(env.SOURCE_DATABASE_ID, payload.day),
				manifestKey: payload.manifestKey,
			})
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
		case FRESHNESS_CRON: {
			const results = await Promise.allSettled([
				runFreshnessAndRetry({
					checkFreshness: () => checkFreshness(env, scheduledAt),
					retryBackup: () => retryBackup(env, scheduledAt),
				}),
				sealRecentCompleteDays(env, scheduledAt),
			])
			const errors = results.flatMap((result) =>
				result.status === 'rejected' ? [result.reason] : [],
			)
			if (errors.length === 1) throw errors[0]
			if (errors.length > 1) {
				throw new AggregateError(
					errors,
					'Freshness/retry and full-backup sealing both failed.',
				)
			}
			return
		}
		default:
			throw new BackupError(
				'unknown-schedule',
				`unexpected cron trigger: ${controller.cron}`,
			)
	}
}

export default {
	async fetch(request: Request, env: BackupEnvironment): Promise<Response> {
		return handleControlPlaneFetch(request, env)
	},
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
