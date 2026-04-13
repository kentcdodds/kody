export type JobSchedule =
	| {
			cron: string
	  }
	| {
			intervalMs: number
	  }

export type JobRecord = {
	id: string
	userId: string
	name: string
	serverCode: string
	serverCodeId: string
	schedule: JobSchedule
	timezone: string
	enabled: boolean
	createdAt: string
	updatedAt: string
}

export type JobRunnerError = {
	message: string
	stack: string | null
}

export type JobRunTrigger = 'alarm' | 'run_now'

export type JobRunStatus = 'success' | 'failure'

export type JobRunHistoryEntry = {
	id: number
	trigger: JobRunTrigger
	status: JobRunStatus
	scheduledFor: string | null
	startedAt: string
	finishedAt: string
	durationMs: number
	error: JobRunnerError | null
}

export type JobRunnerStatus = {
	nextRunAt: string | null
	runCount: number
	successCount: number
	failureCount: number
	lastRunStartedAt: string | null
	lastRunFinishedAt: string | null
	lastRunDurationMs: number | null
	lastError: JobRunnerError | null
	killSwitchEnabled: boolean
	historyLimit: number
}

export type JobSummary = JobRecord &
	JobRunnerStatus & {
		scheduleSummary: string
	}

export type JobDetails = JobSummary

export type JobCreateInput = {
	name: string
	serverCode: string
	schedule: JobSchedule
	timezone?: string | null
	enabled?: boolean
}

export type JobUpdatePatch = {
	name?: string
	serverCode?: string
	schedule?: JobSchedule
	timezone?: string | null
	enabled?: boolean
	killSwitchEnabled?: boolean
	historyLimit?: number
}

export type JobRunResult =
	| {
			ok: true
			result: unknown
	  }
	| {
			ok: false
			error: JobRunnerError
	  }
