import { formatJobError } from './schedule.ts'
import { type JobSchedule } from './types.ts'

const maxLoggedJobOutcomes = 10
type SchedulerLogLevel = 'error' | 'info'

export type SchedulerJobOutcomeLog = {
	jobId: string
	scheduleType: JobSchedule['type']
	outcome: 'success' | 'failure'
	nextRunAt: string | null
	deleted: boolean
	error?: string
	rescheduleError?: string
}

type JobSchedulerLogPayload = {
	event: string
	userId?: string
	jobId?: string | null
	scheduleType?: JobSchedule['type']
	nextJobId?: string | null
	nextRunAt?: string | null
	currentAlarmAt?: string | null
	reason?: string
	dueJobCount?: number
	successCount?: number
	errorCount?: number
	jobOutcomes?: Array<SchedulerJobOutcomeLog>
	truncatedJobOutcomeCount?: number
	retryCount?: number
	isRetry?: boolean
	errorName?: string
	errorMessage?: string
	timestamp?: string
}

export function schedulerErrorFields(error: unknown): {
	errorName: string
	errorMessage: string
} {
	if (error instanceof Error) {
		return {
			errorName: error.name,
			errorMessage: error.message,
		}
	}

	return {
		errorName: 'Unknown',
		errorMessage: formatJobError(error),
	}
}

export function summarizeSchedulerJobOutcomes(
	jobOutcomes: Array<SchedulerJobOutcomeLog>,
): Pick<JobSchedulerLogPayload, 'jobOutcomes' | 'truncatedJobOutcomeCount'> {
	if (jobOutcomes.length <= maxLoggedJobOutcomes) {
		return { jobOutcomes }
	}

	return {
		jobOutcomes: jobOutcomes.slice(0, maxLoggedJobOutcomes),
		truncatedJobOutcomeCount: jobOutcomes.length - maxLoggedJobOutcomes,
	}
}

export function logJobSchedulerEvent(input: JobSchedulerLogPayload): void {
	writeSchedulerLog('info', input)
}

export function logJobSchedulerError(input: JobSchedulerLogPayload): void {
	writeSchedulerLog('error', input)
}

function writeSchedulerLog(
	level: SchedulerLogLevel,
	input: JobSchedulerLogPayload,
): void {
	try {
		console[level](
			'job-scheduler',
			JSON.stringify({
				timestamp: input.timestamp ?? new Date().toISOString(),
				...input,
			}),
		)
	} catch (error) {
		console.warn('job-scheduler-log-failed', {
			event: input.event,
			level,
			errorMessage: formatJobError(error),
		})
	}
}
