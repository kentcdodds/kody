/**
 * Platform job auto-cleanup / retention policy.
 *
 * Completed ad-hoc jobs linger only as long as the account's retention windows
 * allow. Package-owned jobs and preserved jobs are never swept. Forever keep is
 * only available via the per-job `preserved` flag — account preferences cannot
 * set unbounded retention.
 */

import { type JobRecord } from './types.ts'

export const packageJobIdPrefix = 'package-job:'

export const defaultJobRetentionDays = {
	successOnce: 14,
	failedOrNeverRanOnce: 60,
	disabledRecurring: 90,
} as const

/** Inclusive bounds for account retention preference overrides (days). */
export const jobRetentionDaysBounds = {
	min: 1,
	max: 365,
} as const

const millisecondsPerDay = 24 * 60 * 60 * 1000

export type JobRetentionPreferences = {
	successOnceDays: number
	failedOrNeverRanOnceDays: number
	disabledRecurringDays: number
}

export type JobRetentionCategory =
	| 'success_once'
	| 'failed_once'
	| 'never_ran_once'
	| 'disabled_recurring'

export type JobRetentionDecision =
	| {
			eligible: false
			reason:
				| 'package'
				| 'preserved'
				| 'active_recurring'
				| 'upcoming_once'
				| 'not_yet_aged'
				| 'unsupported'
	  }
	| {
			eligible: true
			category: JobRetentionCategory
			ageAnchor: string
			retentionDays: number
			deleteAfter: string
	  }

export function isPackageOwnedJobId(jobId: string) {
	return jobId.startsWith(packageJobIdPrefix)
}

export function resolveJobRetentionPreferences(input: {
	successOnceDays?: number | null
	failedOrNeverRanOnceDays?: number | null
	disabledRecurringDays?: number | null
}): JobRetentionPreferences {
	return {
		successOnceDays: clampRetentionDays(
			input.successOnceDays,
			defaultJobRetentionDays.successOnce,
		),
		failedOrNeverRanOnceDays: clampRetentionDays(
			input.failedOrNeverRanOnceDays,
			defaultJobRetentionDays.failedOrNeverRanOnce,
		),
		disabledRecurringDays: clampRetentionDays(
			input.disabledRecurringDays,
			defaultJobRetentionDays.disabledRecurring,
		),
	}
}

export function clampRetentionDays(
	value: number | null | undefined,
	fallback: number,
) {
	if (value == null || !Number.isFinite(value)) {
		return fallback
	}
	const days = Math.trunc(value)
	if (days < jobRetentionDaysBounds.min) {
		return jobRetentionDaysBounds.min
	}
	if (days > jobRetentionDaysBounds.max) {
		return jobRetentionDaysBounds.max
	}
	return days
}

export function validateJobRetentionDaysInput(value: unknown): number | null {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return null
	}
	const days = Math.trunc(value)
	if (days < jobRetentionDaysBounds.min || days > jobRetentionDaysBounds.max) {
		return null
	}
	return days
}

function addDaysIso(iso: string, days: number) {
	const value = Date.parse(iso)
	if (!Number.isFinite(value)) {
		return null
	}
	return new Date(value + days * millisecondsPerDay).toISOString()
}

function isIsoAtOrBefore(iso: string, now: Date) {
	const value = Date.parse(iso)
	return Number.isFinite(value) && value <= now.getTime()
}

/**
 * Past once = run_at is in the past and the job is no longer an upcoming due
 * candidate. Never-ran enabled once jobs stay runnable until they execute or
 * are disabled; completed or disabled once jobs are retention candidates.
 */
export function isPastOnceJob(job: JobRecord, now: Date) {
	if (job.schedule.type !== 'once') {
		return false
	}
	if (!isIsoAtOrBefore(job.schedule.runAt, now)) {
		return false
	}
	const stillRunnableNeverRan =
		job.enabled && !job.killSwitchEnabled && job.runCount === 0
	return !stillRunnableNeverRan
}

export function classifyPastOnceJob(
	job: JobRecord,
): Exclude<JobRetentionCategory, 'disabled_recurring'> | null {
	if (job.schedule.type !== 'once') {
		return null
	}
	if (job.runCount === 0 && job.lastRunAt == null) {
		return 'never_ran_once'
	}
	if (
		job.lastRunStatus === 'success' ||
		(job.successCount > 0 && job.lastRunStatus !== 'error')
	) {
		return 'success_once'
	}
	return 'failed_once'
}

function ageAnchorForCategory(
	job: JobRecord,
	category: JobRetentionCategory,
): string | null {
	switch (category) {
		case 'success_once':
		case 'failed_once':
			return job.lastRunAt ?? job.updatedAt
		case 'never_ran_once':
			return job.schedule.type === 'once' ? job.schedule.runAt : null
		case 'disabled_recurring':
			return job.lastRunAt ?? job.updatedAt
		default: {
			const exhaustive: never = category
			return exhaustive
		}
	}
}

export function evaluateJobRetentionEligibility(input: {
	job: JobRecord
	preferences: JobRetentionPreferences
	now?: Date
}): JobRetentionDecision {
	const now = input.now ?? new Date()
	const job = input.job

	if (isPackageOwnedJobId(job.id)) {
		return { eligible: false, reason: 'package' }
	}
	if (job.preserved) {
		return { eligible: false, reason: 'preserved' }
	}

	if (job.schedule.type === 'once') {
		if (!isPastOnceJob(job, now)) {
			return { eligible: false, reason: 'upcoming_once' }
		}
		const category = classifyPastOnceJob(job)
		if (!category) {
			return { eligible: false, reason: 'unsupported' }
		}
		const retentionDays =
			category === 'success_once'
				? input.preferences.successOnceDays
				: input.preferences.failedOrNeverRanOnceDays
		const ageAnchor = ageAnchorForCategory(job, category)
		if (!ageAnchor) {
			return { eligible: false, reason: 'unsupported' }
		}
		const deleteAfter = addDaysIso(ageAnchor, retentionDays)
		if (!deleteAfter) {
			return { eligible: false, reason: 'unsupported' }
		}
		if (Date.parse(deleteAfter) > now.getTime()) {
			return { eligible: false, reason: 'not_yet_aged' }
		}
		return {
			eligible: true,
			category,
			ageAnchor,
			retentionDays,
			deleteAfter,
		}
	}

	// Recurring (cron / interval): only disabled ad-hoc jobs age out.
	// Kill-switched-but-still-enabled jobs are a user pause, not disabled —
	// do not treat them as retention candidates.
	if (job.enabled) {
		return { eligible: false, reason: 'active_recurring' }
	}
	const category = 'disabled_recurring' as const
	const retentionDays = input.preferences.disabledRecurringDays
	const ageAnchor = ageAnchorForCategory(job, category)
	if (!ageAnchor) {
		return { eligible: false, reason: 'unsupported' }
	}
	const deleteAfter = addDaysIso(ageAnchor, retentionDays)
	if (!deleteAfter) {
		return { eligible: false, reason: 'unsupported' }
	}
	if (Date.parse(deleteAfter) > now.getTime()) {
		return { eligible: false, reason: 'not_yet_aged' }
	}
	return {
		eligible: true,
		category,
		ageAnchor,
		retentionDays,
		deleteAfter,
	}
}
