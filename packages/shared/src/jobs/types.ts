import { type McpCallerContext, type McpUserContext } from '../chat.ts'

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

export type JobRepoCheckPolicy = {
	allowTypecheckFailures?: boolean
}

export type JobRecord = {
	version: 1
	id: string
	userId: string
	name: string
	sourceId: string
	publishedCommit: string | null
	repoCheckPolicy?: JobRepoCheckPolicy
	storageId: string
	params?: Record<string, unknown>
	schedule: JobSchedule
	timezone: string
	enabled: boolean
	killSwitchEnabled: boolean
	/**
	 * When true, platform job auto-cleanup never deletes this job. Preserved
	 * jobs still count toward `scheduled_jobs` and `storage_bytes`.
	 */
	preserved: boolean
	/**
	 * Optional UTC ISO timestamp after which the platform stops scheduling and
	 * auto-disables the job (`enabled = false`). Null means never expires.
	 * Separate from `preserved` (retention) and `lease_expires_at` (claim lease).
	 */
	expiresAt: string | null
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
}

export type JobView = Omit<JobRecord, 'userId'> & {
	scheduleSummary: string
}

export type JobSourceInspection = {
	entrypoint: string | null
	code: string | null
	error: string | null
}

export type JobSearchProjection = {
	id: string
	name: string
	description: string
	scheduleSummary: string
	sourceId: string
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
	| 'executionOrigin'
	| 'remoteConnectors'
	| 'storageContext'
	| 'repoContext'
> & {
	user: McpUserContext
}

export type JobCreateInput = {
	name: string
	code: string
	sourceId?: string | null
	publishedCommit?: string | null
	repoCheckPolicy?: JobRepoCheckPolicy | null
	params?: Record<string, unknown>
	schedule: JobSchedule
	timezone?: string | null
	enabled?: boolean
	killSwitchEnabled?: boolean
	preserved?: boolean
	expiresAt?: string | null
}

export type JobUpdateInput = {
	id: string
	name?: string
	code?: string
	sourceId?: string | null
	publishedCommit?: string | null
	repoCheckPolicy?: JobRepoCheckPolicy | null
	params?: Record<string, unknown> | null
	schedule?: JobSchedule
	timezone?: string | null
	enabled?: boolean
	killSwitchEnabled?: boolean
	preserved?: boolean
	/** Pass null to clear expiry. Omit to leave unchanged. */
	expiresAt?: string | null
}

export type JobUpsertInput = {
	id?: string
	name?: string
	code?: string
	sourceId?: string | null
	publishedCommit?: string | null
	repoCheckPolicy?: JobRepoCheckPolicy | null
	params?: Record<string, unknown> | null
	schedule?: JobSchedule
	timezone?: string | null
	enabled?: boolean
	killSwitchEnabled?: boolean
	preserved?: boolean
	expiresAt?: string | null
}
