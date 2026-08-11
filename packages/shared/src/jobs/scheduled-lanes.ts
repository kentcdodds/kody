/**
 * Scheduled-lane names, queue message shape, and cron cadence shared between
 * the jobs worker (which owns the `*​/5 * * * *` cron trigger and the
 * scheduled dispatch queue, ADR 0016) and the main worker (which executes the
 * platform lanes via the `JobsHost` service binding).
 */

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

/**
 * Lanes the jobs worker executes locally (against its own database and
 * Durable Objects). Every other lane is forwarded to the main worker's
 * `JobsHost.runScheduledLane`.
 */
export const jobsWorkerLocalLanes = ['job_schedule_watchdog'] as const

export type JobsWorkerLocalLane = (typeof jobsWorkerLocalLanes)[number]

export function isJobsWorkerLocalLane(
	lane: ScheduledLaneName,
): lane is JobsWorkerLocalLane {
	return (jobsWorkerLocalLanes as ReadonlyArray<string>).includes(lane)
}

export function isScheduledLaneName(
	value: unknown,
): value is ScheduledLaneName {
	return (
		typeof value === 'string' &&
		(scheduledLaneNames as ReadonlyArray<string>).includes(value)
	)
}

export function parseScheduledLaneMessage(
	body: unknown,
): ScheduledLaneMessage | null {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null
	const record = body as Record<string, unknown>
	const lane = record['lane']
	const scheduledTime = record['scheduledTime']
	const cron = record['cron']
	if (
		!isScheduledLaneName(lane) ||
		typeof scheduledTime !== 'number' ||
		!Number.isFinite(scheduledTime) ||
		typeof cron !== 'string'
	) {
		return null
	}
	return { lane, scheduledTime, cron }
}

// Cadence predicates. These are the single source of truth; the main-worker
// modules that implement each lane re-export them so lane implementations and
// dispatch can never drift apart.

export const retentionCronGateMinutes = 5
export const retentionCronIntervalMinutes = 60

export function shouldRunRetentionCron(now: Date) {
	return (
		now.getUTCMinutes() < retentionCronGateMinutes &&
		now.getUTCMinutes() % retentionCronIntervalMinutes === 0
	)
}

export const usageAggregationCronGateMinutes = 5
export const usageAggregationCronIntervalMinutes = 60

export function shouldRunUsageAggregationCron(now: Date) {
	return (
		now.getUTCMinutes() < usageAggregationCronGateMinutes &&
		now.getUTCMinutes() % usageAggregationCronIntervalMinutes === 0
	)
}

export function shouldRunAuthDenialAlertCron(now: Date) {
	// Same hourly gate as retention / usage aggregation (minute 0).
	return now.getUTCMinutes() === 0
}

export function shouldRunEmailDeliveryAlertCron(now: Date) {
	return now.getUTCMinutes() === 0
}

export function shouldRunUsageEntitlementAlertCron(now: Date) {
	return now.getUTCMinutes() === 0
}

/**
 * Nightly DR export window: roughly 00:30–06:10 UTC on the worker's
 * every-5-minute cron (~68 ticks × 20 s ≈ 22 minutes of staging work).
 * Ticks outside this window are skipped so daytime traffic is not competing
 * with a full-platform export. Completed days exit cheaply through the
 * summary-object check.
 */
export function shouldRunDrExportCron(now: Date) {
	const minutes = now.getUTCHours() * 60 + now.getUTCMinutes()
	return minutes >= 30 && minutes <= 6 * 60 + 10
}

/**
 * Daytime catch-up cadence: outside the nightly window, one tick every 15
 * minutes resumes a stranded day until its summary is written. A single tick
 * still spends at most the normal ~20 s budget, so daytime blast radius is
 * bounded while a stranded night finishes within a few hours. Ticks with no
 * stranded day exit after two cheap HEAD-style checks per lookback day.
 */
export function shouldRunDrExportCatchUpCron(now: Date) {
	if (shouldRunDrExportCron(now)) return false
	return now.getUTCMinutes() % 15 === 0
}

/**
 * One cron tick after the export window closes (06:15–06:19 UTC). The
 * watchdog fails loudly (lane failure → Sentry) when the night's staging
 * summary is missing, because the exporter itself never errors when it
 * merely runs out of window.
 */
export function shouldRunDrExportWatchdogCron(now: Date) {
	const minutes = now.getUTCHours() * 60 + now.getUTCMinutes()
	return minutes >= 6 * 60 + 15 && minutes < 6 * 60 + 20
}

export const jobScheduleWatchdogIntervalMinutes = 15

export function shouldRunJobScheduleWatchdogCron(now: Date) {
	return now.getUTCMinutes() % jobScheduleWatchdogIntervalMinutes === 0
}

/**
 * Which lanes a cron tick at `scheduledAt` should dispatch. DR export lanes
 * are dispatched on cadence regardless of configuration; the main worker
 * skips them cheaply when DR export is not configured (the jobs worker has no
 * access to the main worker's DR configuration vars).
 */
export function getScheduledLaneCadence(
	scheduledAt: Date,
): Array<ScheduledLaneName> {
	const lanes: Array<ScheduledLaneName> = [
		'reconcile_artifacts_pushes',
		'repo_session_cleanup',
		'reconcile_inbound_deliveries',
		'system_email_retention',
		'storage_bucket_estimate_backfill',
		'd1_storage_reconciliation',
		'oauth_purge_expired',
	]
	if (shouldRunRetentionCron(scheduledAt)) {
		lanes.push('retention', 'job_retention')
	}
	if (shouldRunUsageAggregationCron(scheduledAt)) {
		lanes.push('usage_aggregation')
	}
	if (shouldRunAuthDenialAlertCron(scheduledAt)) {
		lanes.push('auth_denial_alert')
	}
	if (shouldRunEmailDeliveryAlertCron(scheduledAt)) {
		lanes.push('email_delivery_alert')
	}
	if (shouldRunUsageEntitlementAlertCron(scheduledAt)) {
		lanes.push('usage_entitlement_alert')
	}
	if (
		shouldRunDrExportCron(scheduledAt) ||
		shouldRunDrExportCatchUpCron(scheduledAt)
	) {
		lanes.push('dr_export')
	}
	if (shouldRunDrExportWatchdogCron(scheduledAt)) {
		lanes.push('dr_export_watchdog')
	}
	if (shouldRunJobScheduleWatchdogCron(scheduledAt)) {
		lanes.push('job_schedule_watchdog')
	}
	return lanes
}

export const scheduledDispatchQueueBinding = 'SCHEDULED_DISPATCH_QUEUE'
export const scheduledDispatchQueueName = 'kody-scheduled-dispatch'
export const scheduledDispatchDeadLetterQueueName =
	'kody-scheduled-dispatch-dlq'
