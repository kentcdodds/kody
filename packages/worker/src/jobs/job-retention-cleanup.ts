import {
	defaultJobRetentionDays,
	evaluateJobRetentionEligibility,
	resolveJobRetentionPreferences,
	type JobRetentionPreferences,
	validateJobRetentionDaysInput,
} from './job-retention.ts'
import {
	listJobRetentionCandidateRows,
	maxJobRetentionCandidatesPerRun,
} from './repo.ts'
import { deleteJob } from './service.ts'
import {
	logJobSchedulerError,
	logJobSchedulerEvent,
	schedulerErrorFields,
} from './scheduler-logging.ts'

/**
 * Total wall-clock budget for one job-retention cron run. Candidate SQL already
 * excludes live/held jobs; remaining inactive rows are skipped or deleted
 * cheaply so backlogs shrink across hourly ticks without a durable cursor.
 */
export const jobRetentionRunTimeBudgetMs = 15_000

/** Stay under D1's 100 bound-parameter limit when loading user preferences. */
const maxUserIdsPerPreferencesQuery = 50

export type JobRetentionCleanupResult = {
	scanned: number
	deleted: number
	skipped: number
	errors: number
	timeBudgetExhausted: boolean
}

type UserRetentionRow = {
	stable_user_id: string
	job_retention_success_once_days: number | null
	job_retention_failed_once_days: number | null
	job_retention_disabled_recurring_days: number | null
}

export async function readJobRetentionPreferencesForUser(input: {
	db: D1Database
	userId: string
}): Promise<JobRetentionPreferences> {
	const row = await input.db
		.prepare(
			`SELECT
				job_retention_success_once_days,
				job_retention_failed_once_days,
				job_retention_disabled_recurring_days
			FROM users
			WHERE stable_user_id = ?`,
		)
		.bind(input.userId)
		.first<{
			job_retention_success_once_days: number | null
			job_retention_failed_once_days: number | null
			job_retention_disabled_recurring_days: number | null
		}>()
	return resolveJobRetentionPreferences({
		successOnceDays: row?.job_retention_success_once_days,
		failedOrNeverRanOnceDays: row?.job_retention_failed_once_days,
		disabledRecurringDays: row?.job_retention_disabled_recurring_days,
	})
}

export async function updateJobRetentionPreferencesForUser(input: {
	db: D1Database
	userId: string
	successOnceDays: number
	failedOrNeverRanOnceDays: number
	disabledRecurringDays: number
}) {
	const successOnceDays = validateJobRetentionDaysInput(input.successOnceDays)
	const failedOrNeverRanOnceDays = validateJobRetentionDaysInput(
		input.failedOrNeverRanOnceDays,
	)
	const disabledRecurringDays = validateJobRetentionDaysInput(
		input.disabledRecurringDays,
	)
	if (
		successOnceDays == null ||
		failedOrNeverRanOnceDays == null ||
		disabledRecurringDays == null
	) {
		throw new Error(
			`Job retention days must be integers between 1 and 365. Platform defaults are ${defaultJobRetentionDays.successOnce}/${defaultJobRetentionDays.failedOrNeverRanOnce}/${defaultJobRetentionDays.disabledRecurring}. Forever keep is only available via Preserve on a job.`,
		)
	}
	const result = await input.db
		.prepare(
			`UPDATE users
			SET
				job_retention_success_once_days = ?,
				job_retention_failed_once_days = ?,
				job_retention_disabled_recurring_days = ?,
				updated_at = ?
			WHERE stable_user_id = ?`,
		)
		.bind(
			successOnceDays,
			failedOrNeverRanOnceDays,
			disabledRecurringDays,
			new Date().toISOString(),
			input.userId,
		)
		.run()
	if ((result.meta.changes ?? 0) !== 1) {
		throw new Error('Unable to update job retention preferences.')
	}
	return resolveJobRetentionPreferences({
		successOnceDays,
		failedOrNeverRanOnceDays,
		disabledRecurringDays,
	})
}

async function loadPreferencesByUserId(
	db: D1Database,
	userIds: ReadonlyArray<string>,
): Promise<Map<string, JobRetentionPreferences>> {
	const preferences = new Map<string, JobRetentionPreferences>()
	if (userIds.length === 0) {
		return preferences
	}
	for (
		let offset = 0;
		offset < userIds.length;
		offset += maxUserIdsPerPreferencesQuery
	) {
		const chunk = userIds.slice(offset, offset + maxUserIdsPerPreferencesQuery)
		const placeholders = chunk.map(() => '?').join(', ')
		const { results } = await db
			.prepare(
				`SELECT
					stable_user_id,
					job_retention_success_once_days,
					job_retention_failed_once_days,
					job_retention_disabled_recurring_days
				FROM users
				WHERE stable_user_id IN (${placeholders})`,
			)
			.bind(...chunk)
			.all<UserRetentionRow>()
		for (const row of results ?? []) {
			preferences.set(
				row.stable_user_id,
				resolveJobRetentionPreferences({
					successOnceDays: row.job_retention_success_once_days,
					failedOrNeverRanOnceDays: row.job_retention_failed_once_days,
					disabledRecurringDays: row.job_retention_disabled_recurring_days,
				}),
			)
		}
	}
	return preferences
}

/**
 * Platform sweeper for aged ad-hoc jobs. Runs as an hourly scheduled lane.
 * Deletes reclaim the job row (scheduled_jobs entitlement) and clear the job
 * StorageRunner bucket (storage_bytes write estimate).
 */
export async function pruneJobRetention(input: {
	env: Env
	now?: Date
	timeBudgetMs?: number
	batchSize?: number
}): Promise<JobRetentionCleanupResult> {
	const now = input.now ?? new Date()
	const startedAt = Date.now()
	const timeBudgetMs = input.timeBudgetMs ?? jobRetentionRunTimeBudgetMs
	const batchSize = input.batchSize ?? maxJobRetentionCandidatesPerRun
	let afterId: string | null = null
	let scanned = 0
	let deleted = 0
	let skipped = 0
	let errors = 0
	let timeBudgetExhausted = false

	while (true) {
		if (Date.now() - startedAt >= timeBudgetMs) {
			timeBudgetExhausted = true
			break
		}
		const candidates = await listJobRetentionCandidateRows(input.env.APP_DB, {
			afterId,
			limit: batchSize,
		})
		if (candidates.length === 0) {
			break
		}
		afterId = candidates[candidates.length - 1]?.id ?? afterId
		scanned += candidates.length

		const userIds = [
			...new Set(candidates.map((candidate) => candidate.user_id)),
		]
		const preferencesByUser = await loadPreferencesByUserId(
			input.env.APP_DB,
			userIds,
		)

		for (const candidate of candidates) {
			if (Date.now() - startedAt >= timeBudgetMs) {
				timeBudgetExhausted = true
				break
			}
			const preferences =
				preferencesByUser.get(candidate.user_id) ??
				resolveJobRetentionPreferences({})
			const decision = evaluateJobRetentionEligibility({
				job: candidate.record,
				preferences,
				now,
			})
			if (!decision.eligible) {
				skipped += 1
				continue
			}
			try {
				await deleteJob({
					env: input.env,
					userId: candidate.user_id,
					jobId: candidate.id,
				})
				deleted += 1
				logJobSchedulerEvent({
					event: 'job_retention_deleted',
					userId: candidate.user_id,
					jobId: candidate.id,
					scheduleType: candidate.record.schedule.type,
					reason: decision.category,
				})
			} catch (error) {
				errors += 1
				logJobSchedulerError({
					event: 'job_retention_delete_failed',
					userId: candidate.user_id,
					jobId: candidate.id,
					reason: decision.category,
					...schedulerErrorFields(error),
				})
			}
		}

		if (timeBudgetExhausted || candidates.length < batchSize) {
			break
		}
	}

	logJobSchedulerEvent({
		event: 'job_retention_prune',
		reason: timeBudgetExhausted ? 'time_budget_exhausted' : 'drained',
	})

	return {
		scanned,
		deleted,
		skipped,
		errors,
		timeBudgetExhausted,
	}
}
