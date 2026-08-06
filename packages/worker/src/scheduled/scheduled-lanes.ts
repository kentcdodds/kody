import * as Sentry from '@sentry/cloudflare'
import {
	checkUsageEntitlementPressureAndNotify,
	shouldRunUsageEntitlementAlertCron,
} from '#app/usage-entitlement-alerts.ts'
import {
	checkAuthDenialBurstAndNotify,
	shouldRunAuthDenialAlertCron,
} from '#app/auth-denial-alerts.ts'
import {
	checkEmailDeliveryBurstAndNotify,
	shouldRunEmailDeliveryAlertCron,
} from '#app/email-delivery-alerts.ts'
import { pruneRetention, shouldRunRetentionCron } from '#app/retention.ts'
import { isRetryableD1LockError } from '#worker/d1-retry.ts'
import {
	isDrExportConfigured,
	runDrExportTick,
	runDrExportWatchdogTick,
	shouldRunDrExportCron,
	shouldRunDrExportWatchdogCron,
} from '#worker/dr/exporter.ts'
import { sweepStaleInboundDeliveries } from '#worker/email/reconcile-inbound-deliveries.ts'
import { pruneSystemEmailRetention } from '#worker/email/system-email.ts'
import { reconcileD1StorageBytes } from '#worker/entitlements/d1-storage-reconciliation.ts'
import { pruneJobRetention } from '#worker/jobs/job-retention-cleanup.ts'
import {
	runJobScheduleWatchdogTick,
	shouldRunJobScheduleWatchdogCron,
} from '#worker/jobs/job-schedule-watchdog.ts'
import { reconcileArtifactsPushes } from '#worker/jobs/reconcile-artifacts-pushes.ts'
import { cleanupRepoSessionBranches } from '#worker/repo/repo-session-cleanup.ts'
import { backfillStorageBucketEstimates } from '#worker/storage-buckets/estimate-backfill.ts'
import {
	aggregateUsageRollups,
	shouldRunUsageAggregationCron,
} from '#worker/usage/aggregate-rollups.ts'

export const scheduledLaneNames = [
	'reconcile_artifacts_pushes',
	'repo_session_cleanup',
	'reconcile_inbound_deliveries',
	'system_email_retention',
	'storage_bucket_estimate_backfill',
	'd1_storage_reconciliation',
	'oauth_purge_expired',
	'retention',
	'job_retention',
	'usage_aggregation',
	'auth_denial_alert',
	'email_delivery_alert',
	'usage_entitlement_alert',
	'dr_export',
	'dr_export_watchdog',
	'job_schedule_watchdog',
] as const

export type ScheduledLaneName = (typeof scheduledLaneNames)[number]

export type ScheduledLaneMessage = {
	lane: ScheduledLaneName
	scheduledTime: number
	cron: string
}

export function isScheduledLaneName(
	value: unknown,
): value is ScheduledLaneName {
	return (
		typeof value === 'string' &&
		(scheduledLaneNames as ReadonlyArray<string>).includes(value)
	)
}

export function getScheduledLanes(input: {
	env: Env
	scheduledAt: Date
}): Array<ScheduledLaneName> {
	const lanes: Array<ScheduledLaneName> = [
		'reconcile_artifacts_pushes',
		'repo_session_cleanup',
		'reconcile_inbound_deliveries',
		'system_email_retention',
		'storage_bucket_estimate_backfill',
		'd1_storage_reconciliation',
		'oauth_purge_expired',
	]
	if (shouldRunRetentionCron(input.scheduledAt)) {
		lanes.push('retention', 'job_retention')
	}
	if (shouldRunUsageAggregationCron(input.scheduledAt)) {
		lanes.push('usage_aggregation')
	}
	if (shouldRunAuthDenialAlertCron(input.scheduledAt)) {
		lanes.push('auth_denial_alert')
	}
	if (shouldRunEmailDeliveryAlertCron(input.scheduledAt)) {
		lanes.push('email_delivery_alert')
	}
	if (shouldRunUsageEntitlementAlertCron(input.scheduledAt)) {
		lanes.push('usage_entitlement_alert')
	}
	if (
		shouldRunDrExportCron(input.scheduledAt) &&
		isDrExportConfigured(input.env)
	) {
		lanes.push('dr_export')
	}
	if (
		shouldRunDrExportWatchdogCron(input.scheduledAt) &&
		isDrExportConfigured(input.env)
	) {
		lanes.push('dr_export_watchdog')
	}
	if (shouldRunJobScheduleWatchdogCron(input.scheduledAt)) {
		lanes.push('job_schedule_watchdog')
	}
	return lanes
}

export async function runScheduledLane(input: {
	env: Env
	lane: ScheduledLaneName
	scheduledAt: Date
}): Promise<unknown> {
	const baseUrl = input.env.APP_BASE_URL ?? 'https://kody.local'
	switch (input.lane) {
		case 'reconcile_artifacts_pushes':
			return reconcileArtifactsPushes({
				env: input.env,
				baseUrl,
				now: input.scheduledAt,
			})
		case 'repo_session_cleanup':
			return cleanupRepoSessionBranches({
				env: input.env,
				now: input.scheduledAt,
			})
		case 'reconcile_inbound_deliveries':
			return sweepStaleInboundDeliveries({
				env: input.env,
				now: input.scheduledAt,
			})
		case 'system_email_retention':
			return pruneSystemEmailRetention({
				db: input.env.APP_DB,
				blobs: input.env.EMAIL_BLOBS,
				now: input.scheduledAt,
			})
		case 'storage_bucket_estimate_backfill':
			return backfillStorageBucketEstimates({
				env: input.env,
				now: input.scheduledAt,
			})
		case 'd1_storage_reconciliation':
			return reconcileD1StorageBytes({
				db: input.env.APP_DB,
				env: input.env,
				now: input.scheduledAt,
			})
		case 'oauth_purge_expired': {
			const id = input.env.OAUTH_PURGE_COORDINATOR.idFromName('global')
			const stub = input.env.OAUTH_PURGE_COORDINATOR.get(id)
			return stub.run({ scheduledAt: input.scheduledAt.getTime() })
		}
		case 'retention':
			return pruneRetention({ env: input.env, now: input.scheduledAt })
		case 'job_retention':
			return pruneJobRetention({ env: input.env, now: input.scheduledAt })
		case 'usage_aggregation':
			return aggregateUsageRollups(input.env, input.scheduledAt)
		case 'auth_denial_alert':
			return checkAuthDenialBurstAndNotify({
				env: input.env,
				now: input.scheduledAt,
			})
		case 'email_delivery_alert':
			return checkEmailDeliveryBurstAndNotify({
				env: input.env,
				now: input.scheduledAt,
			})
		case 'usage_entitlement_alert':
			return checkUsageEntitlementPressureAndNotify({
				env: input.env,
				now: input.scheduledAt,
			})
		case 'dr_export':
			return runDrExportTick({ env: input.env, now: input.scheduledAt })
		case 'dr_export_watchdog':
			return runDrExportWatchdogTick({
				env: input.env,
				now: input.scheduledAt,
			})
		case 'job_schedule_watchdog':
			return runJobScheduleWatchdogTick({
				env: input.env,
				now: input.scheduledAt,
			})
		default: {
			const exhaustive: never = input.lane
			throw new Error(`Unhandled scheduled lane: ${String(exhaustive)}`)
		}
	}
}

export async function runScheduledLaneWithFailureIsolation(input: {
	env: Env
	message: ScheduledLaneMessage
}): Promise<'completed' | 'd1_lock_contention' | 'failed'> {
	const scheduledAt = new Date(input.message.scheduledTime)
	try {
		await runScheduledLane({
			env: input.env,
			lane: input.message.lane,
			scheduledAt,
		})
		return 'completed'
	} catch (error) {
		if (isRetryableD1LockError(error)) {
			console.warn(
				`scheduled_lane_d1_lock_contention lane=${input.message.lane}`,
				error,
			)
			return 'd1_lock_contention'
		}
		console.error(`scheduled_lane_failed lane=${input.message.lane}`, error)
		Sentry.withScope((scope) => {
			scope.setTag('scheduled.lane', input.message.lane)
			scope.setContext('scheduled', {
				lane: input.message.lane,
				scheduledTime: scheduledAt.toISOString(),
				cron: input.message.cron,
			})
			Sentry.captureException(error)
		})
		return 'failed'
	}
}
