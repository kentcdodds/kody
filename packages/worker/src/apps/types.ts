import {
	type McpCallerContext,
	type McpUserContext,
} from '@kody-internal/shared/chat.ts'
import {
	type UiArtifactParameterDefinition,
	type UiArtifactParameterInput,
} from '@kody-internal/shared/ui-artifact-parameters.ts'

export type AppSchedule =
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

export type AppRunStatus = 'success' | 'error'

export type AppRunHistoryEntry = {
	startedAt: string
	finishedAt: string
	status: AppRunStatus
	durationMs: number
	error?: string
}

export type AppRepoCheckPolicy = {
	allowTypecheckFailures?: boolean
}

export type AppTaskDefinition = {
	name: string
	title: string
	description: string
	entrypoint: string
	keywords?: Array<string>
	searchText?: string | null
	parameters?: Array<UiArtifactParameterInput> | Array<UiArtifactParameterDefinition> | null
	readOnly?: boolean
	idempotent?: boolean
	destructive?: boolean
	usesCapabilities?: Array<string> | null
}

export type AppJobRecord = {
	id: string
	name: string
	title: string
	description: string
	task: string
	params?: Record<string, unknown>
	callerContext: PersistedAppCallerContext | null
	schedule: AppSchedule
	timezone: string
	enabled: boolean
	killSwitchEnabled: boolean
	storageId: string
	lastRunAt?: string
	lastRunStatus?: AppRunStatus
	lastRunError?: string
	lastDurationMs?: number
	nextRunAt: string
	runCount: number
	successCount: number
	errorCount: number
	runHistory: Array<AppRunHistoryEntry>
	createdAt: string
	updatedAt: string
}

export type AppRecord = {
	version: 1
	id: string
	userId: string
	title: string
	description: string
	sourceId: string
	publishedCommit: string | null
	repoCheckPolicy?: AppRepoCheckPolicy
	hidden: boolean
	keywords: Array<string>
	searchText: string | null
	parameters: Array<UiArtifactParameterDefinition> | null
	hasClient: boolean
	hasServer: boolean
	tasks: Array<AppTaskDefinition>
	jobs: Array<AppJobRecord>
	createdAt: string
	updatedAt: string
}

export type AppView = Omit<AppRecord, 'userId'> & {
	jobCount: number
	taskCount: number
	scheduleSummary: Array<string>
}

export type AppExecutionResult =
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

export type AppExecutionOutcome = {
	execution: AppExecutionResult
	startedAt: string
	finishedAt: string
	durationMs: number
}

export type PersistedAppCallerContext = Pick<
	McpCallerContext,
	| 'baseUrl'
	| 'homeConnectorId'
	| 'remoteConnectors'
	| 'storageContext'
	| 'repoContext'
> & {
	user: McpUserContext
}

export type AppSaveTaskInput = {
	name: string
	title?: string
	description: string
	code: string
	keywords?: Array<string>
	searchText?: string | null
	parameters?: Array<UiArtifactParameterInput>
	readOnly?: boolean
	idempotent?: boolean
	destructive?: boolean
	usesCapabilities?: Array<string>
}

export type AppSaveJobInput = {
	id?: string
	name: string
	title?: string
	description?: string
	task: string
	params?: Record<string, unknown>
	schedule: AppSchedule
	timezone?: string | null
	enabled?: boolean
	killSwitchEnabled?: boolean
	storageId?: string
}

export type AppSaveInput = {
	appId?: string
	title: string
	description: string
	hidden?: boolean
	keywords?: Array<string>
	searchText?: string | null
	parameters?: Array<UiArtifactParameterInput>
	clientCode?: string | null
	serverCode?: string | null
	tasks?: Array<AppSaveTaskInput>
	jobs?: Array<AppSaveJobInput>
	repoCheckPolicy?: AppRepoCheckPolicy | null
}
