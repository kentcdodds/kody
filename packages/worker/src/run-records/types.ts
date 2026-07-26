/**
 * Run records: the per-user execution history primitive.
 *
 * Every runtime surface (execute, jobs, workflows, services, package exports,
 * apps, retrievers, subscriptions, inbound webhooks) reports what it ran and
 * how it ended through one contract. Records live in a per-user `RunLog`
 * Durable Object, not in the shared D1 writer — see
 * `docs/contributing/architecture/run-records.md`.
 *
 * Two invariants shape this module:
 *
 * - `state-vs-history`: entity rows own current state, run records own
 *   history. Never derive state (is a service running? how many?) by querying
 *   run records.
 * - `no-per-event-shared-writes`: per-event writes go to Analytics Engine or
 *   a per-user Durable Object, never `APP_DB`.
 */

export const runSurfaceValues = [
	'execute',
	'export',
	'subscription',
	'app_fetch',
	'app_realtime',
	'service',
	'job',
	'workflow',
	'retriever',
	'webhook',
] as const

export type RunSurface = (typeof runSurfaceValues)[number]

export const runStatusValues = ['running', 'success', 'error'] as const

export type RunStatus = (typeof runStatusValues)[number]

export type RunTerminalStatus = Exclude<RunStatus, 'running'>

export const runLogLevelValues = [
	'debug',
	'info',
	'log',
	'warn',
	'error',
] as const

export type RunLogLevel = (typeof runLogLevelValues)[number]

/**
 * When a surface's `running` row is written.
 *
 * - `eager`: a `running` row is written at begin so an evicted or hung run is
 *   still visible. Used by every surface a user cannot watch interactively.
 * - `on-failure`: nothing is persisted unless the run ends in `error`. Used
 *   only by `execute`, which is the highest-volume surface and already returns
 *   its result (and logs) inline to the caller. Success counts for `execute`
 *   come from Analytics Engine via usage metering, not from run records.
 */
export type RunPersistence = 'eager' | 'on-failure'

export function runPersistenceForSurface(surface: RunSurface): RunPersistence {
	switch (surface) {
		case 'execute':
			return 'on-failure'
		case 'export':
		case 'subscription':
		case 'app_fetch':
		case 'app_realtime':
		case 'service':
		case 'job':
		case 'workflow':
		case 'retriever':
		case 'webhook':
			return 'eager'
		default: {
			const exhaustive: never = surface
			throw new Error(`Unhandled run surface: ${String(exhaustive)}`)
		}
	}
}

/**
 * Everything a caller knows about a run when it starts. `packageId`/`kodyId`
 * are optional because ad-hoc execute, standalone `kody.json` jobs, and inline
 * workflows have no owning package — that optionality is why run records are
 * user-scoped rather than package-shaped.
 */
export type RunRecordContext = {
	surface: RunSurface
	name?: string | null
	packageId?: string | null
	kodyId?: string | null
	sourceId?: string | null
	publishedCommit?: string | null
	storageId?: string | null
	jobId?: string | null
	workflowId?: string | null
	invocationId?: string | null
	sessionId?: string | null
	idempotencyKey?: string | null
	parentRunId?: string | null
	metadata?: Record<string, unknown> | null
}

/**
 * Returned by `beginRunRecord`. The id is minted client-side and the full
 * context travels with the handle so `finishRunRecord` can upsert a complete
 * row in one RPC even when the fire-and-forget `running` insert never landed.
 * That is what keeps run recording off the request critical path.
 */
export type RunRecordHandle = {
	id: string
	userId: string
	startedAt: string
	persistence: RunPersistence
	context: RunRecordContext
}

export type RunRecord = {
	id: string
	surface: RunSurface
	status: RunStatus
	name: string | null
	packageId: string | null
	kodyId: string | null
	sourceId: string | null
	publishedCommit: string | null
	storageId: string | null
	jobId: string | null
	workflowId: string | null
	invocationId: string | null
	sessionId: string | null
	idempotencyKey: string | null
	parentRunId: string | null
	startedAt: string
	finishedAt: string | null
	durationMs: number | null
	errorName: string | null
	errorMessage: string | null
	metadata: Record<string, unknown>
	logCount: number
}

export type RunRecordLog = {
	runId: string
	sequence: number
	level: RunLogLevel
	message: string
	fields: Record<string, unknown> | null
}

/**
 * Log input accepted by `finishRunRecord`. Plain strings keep the sandbox
 * executor's existing `logs: Array<string>` shape working unchanged; the
 * object form lets surfaces that know the level (app handlers, services)
 * record it instead of flattening everything to `log`.
 */
export type RunRecordLogInput =
	| string
	| {
			level?: RunLogLevel
			message: string
			fields?: Record<string, unknown> | null
	  }

export type RunRecordFilter = {
	surface?: RunSurface | null
	status?: RunStatus | null
	packageId?: string | null
	jobId?: string | null
	/** Exact match on the run's display `name` (e.g. webhook or job name). */
	name?: string | null
	/** ISO 8601 lower bound on `startedAt`, inclusive. */
	since?: string | null
}

export type RunRecordPage = {
	runs: Array<RunRecord>
	/** Opaque cursor for the next page; `null` when the page is the last. */
	nextCursor: string | null
}

export type RunRecordSurfaceSummary = {
	surface: RunSurface
	total: number
	errors: number
}

export type RunRecordSummary = {
	since: string
	total: number
	errors: number
	running: number
	bySurface: Array<RunRecordSurfaceSummary>
}

/** Persistence caps enforced inside the Durable Object, not by a global cron. */
export const runRecordRetentionDays = 30
export const runRecordMaxRunsPerUser = 2_000
export const runRecordMaxLogEntriesPerRun = 200
export const runRecordMaxTextBytes = 16 * 1024
export const runRecordMaxJsonBytes = 32 * 1024
export const runRecordDefaultPageSize = 25
export const runRecordMaxPageSize = 100

/**
 * Age/excess retention and stale-`running` reconciliation run every Nth
 * `finishRun` (and on the DO alarm), not on every finish.
 */
export const runRecordRetentionEveryNFinishes = 32

/**
 * `running` rows older than this are marked terminal with outcome-unknown.
 * History only — live service/job state lives on entity rows, not here.
 */
export const runRecordStaleRunningTtlMs = 24 * 60 * 60 * 1000

/** How often the DO alarm re-runs retention when the object is otherwise idle. */
export const runRecordRetentionAlarmMs = 60 * 60 * 1000
