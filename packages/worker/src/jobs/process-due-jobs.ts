import { type SchedulerJobOutcomeLog } from './scheduler-logging.ts'
import { computeNextRunAt, formatJobError } from './schedule.ts'
import {
	type JobExecutionOutcome,
	type JobRecord,
	type JobRunStatus,
} from './types.ts'

export type ProcessDueJobsResult = {
	deleteJobIds: Array<string>
	saveJobs: Array<JobRecord>
	successCount: number
	errorCount: number
	jobOutcomes: Array<SchedulerJobOutcomeLog>
}

const maxRunHistoryEntries = 10

export async function processDueJobs(input: {
	jobs: Array<JobRecord>
	now?: Date
	executeJob: (job: JobRecord) => Promise<JobExecutionOutcome>
}): Promise<ProcessDueJobsResult> {
	const now = input.now ?? new Date()
	const deleteJobIds: Array<string> = []
	const saveJobs: Array<JobRecord> = []
	const jobOutcomes: Array<SchedulerJobOutcomeLog> = []
	let successCount = 0
	let errorCount = 0

	for (const job of input.jobs) {
		const outcome = await input.executeJob(job).catch((error) => {
			const startedAt = now.toISOString()
			return {
				execution: {
					ok: false as const,
					error: formatJobError(error),
					logs: [],
				},
				startedAt,
				finishedAt: startedAt,
				durationMs: 0,
			}
		})
		const executionError = outcome.execution.ok
			? undefined
			: outcome.execution.error
		if (outcome.execution.ok) {
			successCount += 1
		} else {
			errorCount += 1
		}

		if (job.schedule.type === 'once') {
			deleteJobIds.push(job.id)
			jobOutcomes.push({
				jobId: job.id,
				scheduleType: job.schedule.type,
				outcome: outcome.execution.ok ? 'success' : 'failure',
				nextRunAt: null,
				deleted: true,
				...(executionError ? { error: executionError } : {}),
			})
			continue
		}

		try {
			const updated = applyExecutionOutcome(job, outcome, {
				updatedAt: now.toISOString(),
				nextRunAt: computeNextRunAt({
					schedule: job.schedule,
					timezone: job.timezone,
					from: now,
				}),
			})
			saveJobs.push(updated)
			jobOutcomes.push({
				jobId: job.id,
				scheduleType: job.schedule.type,
				outcome: outcome.execution.ok ? 'success' : 'failure',
				nextRunAt: updated.nextRunAt,
				deleted: false,
				...(executionError ? { error: executionError } : {}),
			})
		} catch (error) {
			const rescheduleError = formatJobError(error)
			if (outcome.execution.ok) {
				successCount -= 1
				errorCount += 1
			}
			const failedRescheduleError = `Failed to reschedule job: ${rescheduleError}`
			const updated = applyExecutionOutcome(
				job,
				outcome.execution.ok
					? {
							...outcome,
							execution: {
								ok: false as const,
								error: failedRescheduleError,
								logs: outcome.execution.logs,
							},
						}
					: outcome,
				{
					updatedAt: now.toISOString(),
					enabled: false,
					lastRunError: failedRescheduleError,
				},
			)
			saveJobs.push(updated)
			jobOutcomes.push({
				jobId: job.id,
				scheduleType: job.schedule.type,
				outcome: 'failure',
				nextRunAt: updated.nextRunAt,
				deleted: false,
				error: executionError ?? rescheduleError,
				rescheduleError,
			})
		}
	}

	return {
		deleteJobIds,
		saveJobs,
		successCount,
		errorCount,
		jobOutcomes,
	}
}

export function applyExecutionOutcome(
	job: JobRecord,
	outcome: JobExecutionOutcome,
	overrides: Partial<JobRecord> = {},
): JobRecord {
	const status: JobRunStatus = outcome.execution.ok ? 'success' : 'error'
	const executionError =
		overrides.lastRunError ??
		(outcome.execution.ok ? undefined : outcome.execution.error)
	return {
		...job,
		updatedAt: overrides.updatedAt ?? outcome.finishedAt,
		lastRunAt: outcome.finishedAt,
		lastRunStatus: status,
		lastRunError: executionError,
		lastDurationMs: outcome.durationMs,
		nextRunAt: overrides.nextRunAt ?? job.nextRunAt,
		enabled: overrides.enabled ?? job.enabled,
		killSwitchEnabled: overrides.killSwitchEnabled ?? job.killSwitchEnabled,
		runCount: job.runCount + 1,
		successCount: job.successCount + (outcome.execution.ok ? 1 : 0),
		errorCount: job.errorCount + (outcome.execution.ok ? 0 : 1),
		runHistory: [
			{
				startedAt: outcome.startedAt,
				finishedAt: outcome.finishedAt,
				status,
				durationMs: outcome.durationMs,
				...(executionError ? { error: executionError } : {}),
			},
			...job.runHistory,
		].slice(0, maxRunHistoryEntries),
	}
}
