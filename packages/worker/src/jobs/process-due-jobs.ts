import { computeNextRunAt, formatJobError } from './schedule.ts'
import {
	type JobExecutionOutcome,
	type JobRecord,
	type JobRunStatus,
} from './types.ts'

type ProcessDueJobsResult = {
	deleteJobIds: Array<string>
	saveJobs: Array<JobRecord>
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

		if (job.schedule.type === 'once') {
			deleteJobIds.push(job.id)
			continue
		}

		try {
			saveJobs.push(
				applyExecutionOutcome(job, outcome, {
					updatedAt: now.toISOString(),
					nextRunAt: computeNextRunAt({
						schedule: job.schedule,
						timezone: job.timezone,
						from: now,
					}),
				}),
			)
		} catch (error) {
			saveJobs.push(
				applyExecutionOutcome(job, outcome, {
					updatedAt: now.toISOString(),
					enabled: false,
					lastRunError: `Failed to reschedule job: ${formatJobError(error)}`,
				}),
			)
		}
	}

	return {
		deleteJobIds,
		saveJobs,
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
