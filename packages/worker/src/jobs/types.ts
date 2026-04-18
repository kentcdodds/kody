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

export type JobRepoCheckPolicy = {
	allowTypecheckFailures?: boolean
}

export type JobRecord = {
	version: 1
	id: string
	userId: string
	name: string
	code: string | null
	sourceId: string | null
	publishedCommit: string | null
	repoCheckPolicy?: JobRepoCheckPolicy
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

export type JobSearchProjection = {
	id: string
	name: string
	description: string
	scheduleSummary: string
	sourceId: string | null
	publishedCommit: string | null
	storageId: string
	updatedAt: string
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
	| 'baseUrl'
	| 'homeConnectorId'
	| 'remoteConnectors'
	| 'storageContext'
	| 'repoContext'
> & {
	user: McpUserContext
}

export type JobCreateInput = {
	name: string
	code?: string | null
	sourceId?: string | null
	publishedCommit?: string | null
	repoCheckPolicy?: JobRepoCheckPolicy | null
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
	sourceId?: string | null
	publishedCommit?: string | null
	repoCheckPolicy?: JobRepoCheckPolicy | null
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
	sourceId?: string | null
	publishedCommit?: string | null
	repoCheckPolicy?: JobRepoCheckPolicy | null
	params?: Record<string, unknown> | null
	schedule?: JobSchedule
	timezone?: string | null
	enabled?: boolean
	killSwitchEnabled?: boolean
}
