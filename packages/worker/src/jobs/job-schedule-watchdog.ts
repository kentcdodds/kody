import * as Sentry from '@sentry/cloudflare'
import { withAccountWriteLease } from '#worker/account/deletion-state.ts'
import { runD1WithRetry } from '#worker/d1-retry.ts'
import { syncJobManagerAlarm } from './manager-client.ts'
import { computeNextRunAt } from './schedule.ts'
import {
	advanceStuckSkippedJobNextRunAt,
	listSilentlyOverdueJobRowsPage,
	listStuckSkippedJobRowsPage,
	type JobRow,
} from './repo.ts'
import { logJobSchedulerEvent } from './scheduler-logging.ts'

/**
 * Platform cron that detects enabled recurring jobs that should already have
 * run (or are permanently skipped by a stuck occurrence fence) and re-arms
 * each affected user's JobManager alarm. Complements at-least-once claim
 * safety: leases recover overlapping runs, but nothing else notices when a
 * per-user Durable Object alarm is lost or a fence leaves next_run_at stuck.
 */

/** Due jobs older than this are treated as silently overdue. */
export const jobScheduleWatchdogGraceMs = 5 * 60 * 1_000
/** Worker cron fires every 5 minutes; run this lane on :00/:15/:30/:45. */
export const jobScheduleWatchdogIntervalMinutes = 15
export const jobScheduleWatchdogPageSize = 100
export const jobScheduleWatchdogMaxUsersPerTick = 50
export const jobScheduleWatchdogMaxJobsLogged = 20
/** Avoid re-paging Sentry on the same sustained overdue set every tick. */
export const jobScheduleWatchdogAlertCooldownMinutes = 6 * 60
export const jobScheduleWatchdogAlertKvKey =
	'ops-alert:job-schedule-watchdog:v1'

type JobScheduleWatchdogEnv = {
	APP_DB: D1Database
	JOB_MANAGER?: Env['JOB_MANAGER']
	BUNDLE_ARTIFACTS_KV?: KVNamespace
}

export function shouldRunJobScheduleWatchdogCron(now: Date) {
	return now.getUTCMinutes() % jobScheduleWatchdogIntervalMinutes === 0
}

export type JobScheduleWatchdogResult = {
	overdueJobCount: number
	stuckSkippedJobCount: number
	repairedStuckJobCount: number
	usersSynced: number
	usersSkippedCap: number
	alerted: boolean
}

function summarizeJobs(rows: Array<JobRow>) {
	return rows.slice(0, jobScheduleWatchdogMaxJobsLogged).map((row) => ({
		jobId: row.id,
		userId: row.user_id,
		name: row.name,
		nextRunAt: row.next_run_at,
		lastRunAt: row.last_run_at,
		lastCompletedScheduledFor: row.last_completed_scheduled_for,
	}))
}

async function collectPagedJobRows(input: {
	page: (afterId: string | null) => Promise<Array<JobRow>>
}): Promise<Array<JobRow>> {
	const rows: Array<JobRow> = []
	let afterId: string | null = null
	while (true) {
		const page = await runD1WithRetry(() => input.page(afterId))
		if (page.length === 0) break
		rows.push(...page)
		if (page.length < jobScheduleWatchdogPageSize) break
		afterId = page[page.length - 1]!.id
	}
	return rows
}

async function maybeCaptureWatchdogAlert(input: {
	env: JobScheduleWatchdogEnv
	now: Date
	result: Omit<JobScheduleWatchdogResult, 'alerted'>
	overdueSample: Array<JobRow>
	stuckSample: Array<JobRow>
}): Promise<boolean> {
	if (
		input.result.overdueJobCount === 0 &&
		input.result.stuckSkippedJobCount === 0
	) {
		return false
	}

	let alerted = true
	if (input.env.BUNDLE_ARTIFACTS_KV) {
		const lastSentRaw = await input.env.BUNDLE_ARTIFACTS_KV.get(
			jobScheduleWatchdogAlertKvKey,
		)
		const lastSentMs = lastSentRaw ? Number(lastSentRaw) : NaN
		if (
			Number.isFinite(lastSentMs) &&
			input.now.getTime() - lastSentMs <
				jobScheduleWatchdogAlertCooldownMinutes * 60_000
		) {
			alerted = false
		} else {
			await input.env.BUNDLE_ARTIFACTS_KV.put(
				jobScheduleWatchdogAlertKvKey,
				String(input.now.getTime()),
			)
		}
	}

	const payload = {
		...input.result,
		overdueSample: summarizeJobs(input.overdueSample),
		stuckSample: summarizeJobs(input.stuckSample),
	}
	console.warn('job-schedule-watchdog-overdue', payload)
	if (alerted) {
		Sentry.withScope((scope) => {
			scope.setTag('scheduled.lane', 'job_schedule_watchdog')
			scope.setContext('job_schedule_watchdog', payload)
			Sentry.captureMessage(
				'Enabled jobs were silently overdue or stuck-skipped; JobManager alarms were re-synced.',
				'warning',
			)
		})
	}
	return alerted
}

export async function runJobScheduleWatchdogTick(input: {
	env: JobScheduleWatchdogEnv
	now?: Date
}): Promise<JobScheduleWatchdogResult> {
	const now = input.now ?? new Date()
	const nowIso = now.toISOString()
	const overdueBeforeIso = new Date(
		now.getTime() - jobScheduleWatchdogGraceMs,
	).toISOString()

	const overdueRows = await collectPagedJobRows({
		page: (afterId) =>
			listSilentlyOverdueJobRowsPage(input.env.APP_DB, {
				overdueBeforeIso,
				nowIso,
				afterId,
				limit: jobScheduleWatchdogPageSize,
			}),
	})
	const stuckRows = await collectPagedJobRows({
		page: (afterId) =>
			listStuckSkippedJobRowsPage(input.env.APP_DB, {
				afterId,
				limit: jobScheduleWatchdogPageSize,
			}),
	})

	let repairedStuckJobCount = 0
	const usersNeedingSync = new Set<string>()
	for (const row of overdueRows) {
		usersNeedingSync.add(row.user_id)
	}

	for (const row of stuckRows) {
		usersNeedingSync.add(row.user_id)
		if (row.record.schedule.type === 'once') {
			continue
		}
		try {
			const nextRunAt = computeNextRunAt({
				schedule: row.record.schedule,
				timezone: row.record.timezone,
				from: now,
			})
			const repaired = await withAccountWriteLease({
				db: input.env.APP_DB,
				stableUserId: row.user_id,
				async write() {
					return advanceStuckSkippedJobNextRunAt({
						db: input.env.APP_DB,
						userId: row.user_id,
						jobId: row.id,
						nextRunAt,
						updatedAt: nowIso,
					})
				},
			})
			if (repaired) {
				repairedStuckJobCount += 1
				logJobSchedulerEvent({
					event: 'watchdog_repaired_stuck_skipped_job',
					userId: row.user_id,
					jobId: row.id,
					scheduleType: row.record.schedule.type,
					nextRunAt,
					reason: 'last_completed_equals_occurrence',
				})
			}
		} catch (error) {
			console.warn('job-schedule-watchdog-repair-failed', {
				jobId: row.id,
				userId: row.user_id,
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}

	const userIds = [...usersNeedingSync].sort()
	const usersToSync = userIds.slice(0, jobScheduleWatchdogMaxUsersPerTick)
	const usersSkippedCap = Math.max(
		0,
		userIds.length - jobScheduleWatchdogMaxUsersPerTick,
	)
	let usersSynced = 0
	for (const userId of usersToSync) {
		await syncJobManagerAlarm({ env: input.env as Env, userId })
		usersSynced += 1
		logJobSchedulerEvent({
			event: 'watchdog_sync_alarm',
			userId,
			reason: 'silently_overdue_or_stuck_skipped',
		})
	}

	const baseResult = {
		overdueJobCount: overdueRows.length,
		stuckSkippedJobCount: stuckRows.length,
		repairedStuckJobCount,
		usersSynced,
		usersSkippedCap,
	}
	const alerted = await maybeCaptureWatchdogAlert({
		env: input.env,
		now,
		result: baseResult,
		overdueSample: overdueRows,
		stuckSample: stuckRows,
	})

	return {
		...baseResult,
		alerted,
	}
}
