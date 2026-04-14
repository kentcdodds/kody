import {
	type McpCallerContext,
	type McpUserContext,
} from '@kody-internal/shared/chat.ts'

export type JobSchedule =
	| {
			type: 'cron'
			expression: string
	  }
	| {
			type: 'interval'
			every: string
	  }
	| {
			type: 'once'
			runAt: string
	  }

export type JobRunStatus = 'success' | 'error'

export type JobRunHistoryEntry = {
	startedAt: string
	finishedAt: string
	status: JobRunStatus
	durationMs: number
	error?: string
}

export type JobRecord = {
	version: 1
	id: string
	userId: string
	name: string
	code: string
	storageId: string
	params?: Record<string, unknown>
	schedule: JobSchedule
	timezone: string
	enabled: boolean
	killSwitchEnabled: boolean
	createdAt: string
	updatedAt: string
	lastRunAt?: string
	lastRunStatus?: JobRunStatus
	lastRunError?: string
	lastDurationMs?: number
	nextRunAt: string
	runCount: number
	successCount: number
	errorCount: number
	runHistory: Array<JobRunHistoryEntry>
}

export type JobView = Omit<JobRecord, 'userId'> & {
	scheduleSummary: string
}

export const jobStorageIdPrefix = 'job:'

export function buildJobStorageId(jobId: string) {
	return `${jobStorageIdPrefix}${jobId}`
}

export type JobExecutionResult =
	| {
			ok: true
			result?: unknown
			logs: Array<string>
	  }
	| {
			ok: false
			error: string
			logs: Array<string>
	  }

export type JobExecutionOutcome = {
	execution: JobExecutionResult
	startedAt: string
	finishedAt: string
	durationMs: number
}

export type PersistedJobCallerContext = Pick<
	McpCallerContext,
	'baseUrl' | 'homeConnectorId' | 'remoteConnectors' | 'storageContext'
> & {
	user: McpUserContext
}

export type JobCreateInput = {
	name: string
	code: string
	params?: Record<string, unknown>
	schedule: JobSchedule
	timezone?: string | null
	enabled?: boolean
	killSwitchEnabled?: boolean
}

export type JobUpdateInput = {
	id: string
	name?: string
	code?: string | null
	params?: Record<string, unknown> | null
	schedule?: JobSchedule
	timezone?: string | null
	enabled?: boolean
	killSwitchEnabled?: boolean
}

export type JobUpsertInput = {
	id?: string
	name?: string
	code?: string | null
	params?: Record<string, unknown> | null
	schedule?: JobSchedule
	timezone?: string | null
	enabled?: boolean
	killSwitchEnabled?: boolean
}
