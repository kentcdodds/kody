import { type McpCallerContext, type McpUserContext } from '@kody-internal/shared/chat.ts'

export type ScheduledJobSchedule =
	| {
			type: 'cron'
			expression: string
	  }
	| {
			type: 'once'
			runAt: string
	  }

export type ScheduledJobRunStatus = 'success' | 'error'

export type ScheduledJob = {
	id: string
	name: string
	code: string
	params?: Record<string, unknown>
	schedule: ScheduledJobSchedule
	timezone: string
	enabled: boolean
	createdAt: string
	lastRunAt?: string
	lastRunStatus?: ScheduledJobRunStatus
	lastRunError?: string
	nextRunAt: string
}

export type ScheduledJobView = ScheduledJob & {
	scheduleSummary: string
}

export type SchedulerExecutionResult =
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

export type PersistedSchedulerCallerContext = Pick<
	McpCallerContext,
	'baseUrl' | 'homeConnectorId' | 'remoteConnectors' | 'storageContext'
> & {
	user: McpUserContext
}

export type SchedulerCreateInput = {
	name: string
	code: string
	params?: Record<string, unknown>
	schedule: ScheduledJobSchedule
	timezone?: string | null
	enabled?: boolean
}

export type SchedulerUpdateInput = {
	id: string
	name?: string
	code?: string
	params?: Record<string, unknown> | null
	schedule?: ScheduledJobSchedule
	timezone?: string | null
	enabled?: boolean
}
