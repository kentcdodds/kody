import {
	computeNextRunAt,
	formatSchedulerError,
} from './schedule.ts'
import {
	type ScheduledJob,
	type SchedulerExecutionResult,
} from './types.ts'

type ProcessDueJobsResult = {
	deleteJobIds: Array<string>
	saveJobs: Array<ScheduledJob>
}

export async function processDueJobs(input: {
	jobs: Array<ScheduledJob>
	now?: Date
	executeJob: (job: ScheduledJob) => Promise<SchedulerExecutionResult>
}): Promise<ProcessDueJobsResult> {
	const now = input.now ?? new Date()
	const lastRunAt = now.toISOString()
	const deleteJobIds: Array<string> = []
	const saveJobs: Array<ScheduledJob> = []

	for (const job of input.jobs) {
		const execution = await input.executeJob(job).catch((error) => ({
			ok: false as const,
			error: formatSchedulerError(error),
			logs: [],
		}))

		if (job.schedule.type === 'once') {
			deleteJobIds.push(job.id)
			continue
		}

		try {
			saveJobs.push({
				...job,
				lastRunAt,
				lastRunStatus: execution.ok ? 'success' : 'error',
				lastRunError: execution.ok ? undefined : execution.error,
				nextRunAt: computeNextRunAt({
					schedule: job.schedule,
					timezone: job.timezone,
					from: now,
				}),
			})
		} catch (error) {
			saveJobs.push({
				...job,
				enabled: false,
				lastRunAt,
				lastRunStatus: 'error',
				lastRunError: `Failed to reschedule job: ${formatSchedulerError(error)}`,
			})
		}
	}

	return {
		deleteJobIds,
		saveJobs,
	}
}
