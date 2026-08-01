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
/** Cap cross-user page accumulation so a large backlog cannot OOM the cron. */
export const jobScheduleWatchdogMaxRowsPerTick = 5_000
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
	USER_METER?: DurableObjectNamespace
}

export function shouldRunJobScheduleWatchdogCron(now: Date) {
	return now.getUTCMinutes() % jobScheduleWatchdogIntervalMinutes === 0
}

export type JobScheduleWatchdogResult = {
	overdueJobCount: number
	stuckSkippedJobCount: number
	repairedStuckJobCount: number
	usersSynced: number
	usersFailedSync: number
	usersSkippedCap: number
	scanTruncated: boolean
	alerted: boolean
}

function summarizeJobs(rows: Array<JobRow>) {
	// Omit user-authored job names from ops/Sentry payloads; job ids are enough.
	// Detection uses scheduling fences (next_run_at / claim / completed-for);
	// last_run_at is retention/observability and not needed in the sample.
	return rows.slice(0, jobScheduleWatchdogMaxJobsLogged).map((row) => ({
		jobId: row.id,
		userId: row.user_id,
		nextRunAt: row.next_run_at,
		lastCompletedScheduledFor: row.last_completed_scheduled_for,
	}))
}

async function collectPagedJobRows(input: {
	page: (afterId: string | null) => Promise<Array<JobRow>>
}): Promise<{ rows: Array<JobRow>; truncated: boolean }> {
	const rows: Array<JobRow> = []
	let afterId: string | null = null
	while (true) {
		const page = await runD1WithRetry(() => input.page(afterId))
		if (page.length === 0) break
		rows.push(...page)
		if (page.length < jobScheduleWatchdogPageSize) {
			return { rows, truncated: false }
		}
		if (rows.length >= jobScheduleWatchdogMaxRowsPerTick) {
			return {
				rows: rows.slice(0, jobScheduleWatchdogMaxRowsPerTick),
				truncated: true,
			}
		}
		afterId = page[page.length - 1]!.id
	}
	return { rows, truncated: false }
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

	const overduePage = await collectPagedJobRows({
		page: (afterId) =>
			listSilentlyOverdueJobRowsPage(input.env.APP_DB, {
				overdueBeforeIso,
				nowIso,
				afterId,
				limit: jobScheduleWatchdogPageSize,
			}),
	})
	const stuckPage = await collectPagedJobRows({
		page: (afterId) =>
			listStuckSkippedJobRowsPage(input.env.APP_DB, {
				nowIso,
				afterId,
				limit: jobScheduleWatchdogPageSize,
			}),
	})
	const overdueRows = overduePage.rows
	const stuckRows = stuckPage.rows
	const scanTruncated = overduePage.truncated || stuckPage.truncated

	let repairedStuckJobCount = 0
	const usersNeedingSync = new Set<string>()
	for (const row of overdueRows) {
		usersNeedingSync.add(row.user_id)
	}

	for (const row of stuckRows) {
		usersNeedingSync.add(row.user_id)
		try {
			const nextRunAt = computeNextRunAt({
				schedule: row.record.schedule,
				timezone: row.record.timezone,
				from: now,
			})
			const repaired = await withAccountWriteLease({
				db: input.env.APP_DB,
				stableUserId: row.user_id,
				env: input.env,
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
	let usersFailedSync = 0
	for (const userId of usersToSync) {
		try {
			await syncJobManagerAlarm({ env: input.env as Env, userId })
			usersSynced += 1
			logJobSchedulerEvent({
				event: 'watchdog_sync_alarm',
				userId,
				reason: 'silently_overdue_or_stuck_skipped',
			})
		} catch (error) {
			usersFailedSync += 1
			console.warn('job-schedule-watchdog-sync-failed', {
				userId,
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}

	const baseResult = {
		overdueJobCount: overdueRows.length,
		stuckSkippedJobCount: stuckRows.length,
		repairedStuckJobCount,
		usersSynced,
		usersFailedSync,
		usersSkippedCap,
		scanTruncated,
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
