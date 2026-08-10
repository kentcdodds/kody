import * as Sentry from '@sentry/cloudflare'
import { DurableObject } from 'cloudflare:workers'
import {
	chunkArray,
	maxD1BoundParameters,
} from '@kody-internal/shared/chunk.ts'
import { toJsonSafeValue } from '@kody-internal/shared/json-safe-value.ts'
import {
	type DurableObjectPitrRpc,
	getRecoveryBookmark,
	restoreToBookmark,
} from '#worker/dr/do-pitr.ts'
import { terminalWorkflowStatusValues } from '#worker/package-runtime/workflow-statuses.ts'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import { type RunLogAdminInsightsSnapshot } from './admin-insights-snapshot.ts'
import {
	type ActivationMilestone,
	type ActivationMilestoneRecord,
	type PackageRunSuccessRecord,
	countsTowardPackageActivation,
} from './package-activation-state.ts'
import {
	type JobRunObservabilityRecord,
	type JobRunObservabilityStatus,
	type JobRunObservabilityUpsertInput,
} from './job-run-observability.ts'
import {
	type WorkflowProjectionRecord,
	type WorkflowProjectionReserveResult,
	type WorkflowProjectionSourceType,
	type WorkflowProjectionUpsertInput,
	creatingWorkflowProjectionStatus,
	workflowProjectionActiveStatuses,
	workflowProjectionCreatingTtlMs,
	workflowProjectionReservationStatuses,
} from './workflow-projection.ts'
import {
	type RunErrorTriage,
	type RunErrorTriageFilter,
	type RunLogLevel,
	type RunRecord,
	type RunRecordLog,
	type RunRecordPage,
	type RunRecordSummary,
	type RunStatus,
	type RunSurface,
	packageInvocationLedgerRetentionDays,
	runErrorTriageMaxNoteLength,
	runErrorTriageValues,
	runRecordMaxJsonBytes,
	runRecordMaxLogEntriesPerRun,
	runRecordMaxRunsPerUser,
	runRecordMaxTextBytes,
	runRecordDefaultPageSize,
	runRecordMaxPageSize,
	runRecordRetentionAlarmMs,
	runRecordRetentionDays,
	runRecordRetentionEveryNFinishes,
	runRecordStaleRunningTtlMsForSurface,
	runSurfaceValues,
	workflowProjectionRetentionDays,
} from './types.ts'

const textEncoder = new TextEncoder()
const maxAgeDeletesPerFinish = 100
const maxExcessDeletesPerFinish = 100
const maxStaleRunningReconcilesPerPass = 100
const maxLedgerAgeDeletesPerPass = 100
const maxWorkflowProjectionAgeDeletesPerPass = 100
const maxStaleCreatingDeletesPerPass = 100

const metaRunCountKey = 'run_count'
const metaFinishesSinceRetentionKey = 'finishes_since_retention'
const metaSchemaVersionKey = 'schema_version'
/** Bump when initializeSchema's DDL set changes; warm objects skip DDL. */
const runLogSchemaVersion = 10

/**
 * Cursor namespaces for `exportRuns` phases after the raw run-id phase.
 * Run-phase cursors stay raw run ids for backward compatibility with cursors
 * minted before later phases existed.
 */
const exportLedgerCursorPrefix = 'invocation-ledger:'
const exportWorkflowProjectionsCursorPrefix = 'workflow-projections:'
const exportJobRunObservabilityCursorPrefix = 'job-run-observability:'
const exportPackageRunSuccessesCursorPrefix = 'package-run-successes:'
const exportActivationMilestonesCursorPrefix = 'activation-milestones:'

const staleRunningErrorName = 'Interrupted'
const staleRunningErrorMessage =
	'Run did not finish; outcome unknown (reconciled after stale running TTL).'

const retentionMs = runRecordRetentionDays * 24 * 60 * 60 * 1000
const ledgerRetentionMs =
	packageInvocationLedgerRetentionDays * 24 * 60 * 60 * 1000
const workflowProjectionRetentionMs =
	workflowProjectionRetentionDays * 24 * 60 * 60 * 1000

const workflowProjectionTerminalStatuses: ReadonlyArray<string> =
	terminalWorkflowStatusValues

export type RunLogRowInput = {
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
	metadataJson: string
	createdAt: string
	updatedAt: string
}

export type RunLogEntryInput = {
	sequence: number
	level: RunLogLevel
	message: string
	fieldsJson: string | null
}

export type PackageInvocationLedgerStatus =
	| 'in_progress'
	| 'completed'
	| 'failed'

/**
 * One keyed package-invocation idempotency row. Same shape as the legacy D1
 * `package_invocations` table minus `user_id` — the DO identity is the user.
 */
export type PackageInvocationLedgerRecord = {
	id: string
	tokenId: string
	packageId: string
	packageKodyId: string
	exportName: string
	idempotencyKey: string
	requestHash: string
	source: string | null
	topic: string | null
	status: PackageInvocationLedgerStatus
	/** Bounded replay cache; `null` when the terminal response was oversized. */
	responseJson: string | null
	createdAt: string
	updatedAt: string
}

export type PackageInvocationLedgerKey = {
	tokenId: string
	packageId: string
	exportName: string
	idempotencyKey: string
}

export type PackageInvocationClaimInput = PackageInvocationLedgerKey & {
	id: string
	packageKodyId: string
	requestHash: string
	source: string | null
	topic: string | null
}

export type PackageInvocationClaimResult =
	| {
			outcome: 'claimed'
			invocationId: string
			claimUpdatedAt: string
			/** True when a stale `in_progress` row was taken over in place. */
			reclaimed: boolean
	  }
	| { outcome: 'existing'; record: PackageInvocationLedgerRecord }

type ListRunsInput = {
	surface?: RunSurface | null
	status?: RunStatus | null
	packageId?: string | null
	jobId?: string | null
	name?: string | null
	since?: string | null
	errorTriage?: RunErrorTriageFilter | null
	limit: number
	cursor?: string | null
}

export type UpdateRunErrorTriageInput = {
	runId: string
	/** `null` clears triage (reopen). */
	errorTriage: RunErrorTriage | null
	/**
	 * When true, keep the existing note (used when the caller omitted `note`
	 * so RPC cannot rely on `undefined` surviving structured clone).
	 */
	preserveTriageNote?: boolean
	/**
	 * `null` or empty clears the note. Ignored when `preserveTriageNote` is
	 * true, and cleared automatically when reopening (`errorTriage: null`).
	 */
	triageNote?: string | null
	triagedBy: string
}

export type UpdateRunErrorTriageResult =
	| { ok: true; run: RunRecord }
	| { ok: false; reason: 'not_found' }
	| { ok: false; reason: 'not_error'; status: RunStatus; runId: string }

export type BulkUpdateRunErrorTriageFilter = {
	surface?: RunSurface | null
	packageId?: string | null
	jobId?: string | null
	name?: string | null
	errorName?: string | null
	errorMessage?: string | null
	errorTriage?: RunErrorTriageFilter | null
}

export type BulkUpdateRunErrorTriageInput = {
	runIds?: Array<string> | null
	filter?: BulkUpdateRunErrorTriageFilter | null
	errorTriage: RunErrorTriage | null
	preserveTriageNote?: boolean
	triageNote?: string | null
	triagedBy: string
	limit: number
	dryRun?: boolean
}

export type BulkUpdateRunErrorTriageResult = {
	matchedRunIds: Array<string>
	updatedCount: number
	hasMore: boolean
}

type ExportRunsInput = {
	pageSize: number
	startAfter?: string | null
}

export type ExportRunsResult = {
	runs: Array<RunRecord>
	logs: Array<RunRecordLog>
	packageInvocations: Array<PackageInvocationLedgerRecord>
	workflowProjections: Array<WorkflowProjectionRecord>
	jobRunObservability: Array<JobRunObservabilityRecord>
	packageRunSuccesses: Array<PackageRunSuccessRecord>
	activationMilestones: Array<ActivationMilestoneRecord>
	nextStartAfter: string | null
	truncated: boolean
}

type CursorPayload = {
	startedAt: string
	id: string
}

type WorkflowProjectionListInput = {
	limit: number
	cursor?: string | null
	status?: string | null
	bindingName?: string | null
}

function truncateUtf8(value: string, maxBytes: number) {
	if (textEncoder.encode(value).length <= maxBytes) return value
	const suffix = '... [truncated]'
	let low = 0
	let high = value.length
	let best = ''
	while (low <= high) {
		const midpoint = Math.floor((low + high) / 2)
		const candidate = `${value.slice(0, midpoint)}${suffix}`
		if (textEncoder.encode(candidate).length <= maxBytes) {
			best = candidate
			low = midpoint + 1
		} else {
			high = midpoint - 1
		}
	}
	return best
}

function serializeJson(value: unknown, maxBytes = runRecordMaxJsonBytes) {
	const json = JSON.stringify(toJsonSafeValue(value))
	if (textEncoder.encode(json).length <= maxBytes) return json
	let preview = truncateUtf8(json, Math.max(0, maxBytes - 128))
	let wrapped = JSON.stringify({
		__truncated__: true,
		preview,
	})
	while (textEncoder.encode(wrapped).length > maxBytes && preview.length > 0) {
		preview = preview.slice(0, Math.floor(preview.length * 0.8))
		wrapped = JSON.stringify({
			__truncated__: true,
			preview,
		})
	}
	return wrapped
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== 'string' || value.length === 0) return {}
	try {
		const parsed = JSON.parse(value) as unknown
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return {}
		}
		return parsed as Record<string, unknown>
	} catch {
		return {}
	}
}

function isRunSurface(value: string): value is RunSurface {
	return (runSurfaceValues as ReadonlyArray<string>).includes(value)
}

function encodeCursor(payload: CursorPayload) {
	return btoa(JSON.stringify(payload))
}

function decodeCursor(cursor: string): CursorPayload | null {
	try {
		const parsed = JSON.parse(atob(cursor)) as unknown
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return null
		}
		const record = parsed as Record<string, unknown>
		const startedAt = record['startedAt']
		const id = record['id']
		if (typeof startedAt !== 'string' || typeof id !== 'string') return null
		return { startedAt, id }
	} catch {
		return null
	}
}

function normalizePageSize(pageSize: number | undefined, fallback: number) {
	const requested =
		typeof pageSize === 'number' && Number.isFinite(pageSize)
			? Math.trunc(pageSize)
			: fallback
	return Math.min(Math.max(requested, 1), runRecordMaxPageSize)
}

function isRunErrorTriage(value: string): value is RunErrorTriage {
	return (runErrorTriageValues as ReadonlyArray<string>).includes(value)
}

function mapRunRow(
	row: Record<string, SqlStorageValue>,
	logCount: number,
): RunRecord {
	const surface = String(row['surface'] ?? '')
	const status = String(row['status'] ?? '')
	const rawTriage =
		row['error_triage'] == null ? null : String(row['error_triage'])
	return {
		id: String(row['id']),
		surface: (isRunSurface(surface) ? surface : 'execute') as RunSurface,
		status: status as RunStatus,
		name: row['name'] == null ? null : String(row['name']),
		packageId: row['package_id'] == null ? null : String(row['package_id']),
		kodyId:
			row['package_kody_id'] == null ? null : String(row['package_kody_id']),
		sourceId: row['source_id'] == null ? null : String(row['source_id']),
		publishedCommit:
			row['published_commit'] == null ? null : String(row['published_commit']),
		storageId: row['storage_id'] == null ? null : String(row['storage_id']),
		jobId: row['job_id'] == null ? null : String(row['job_id']),
		workflowId: row['workflow_id'] == null ? null : String(row['workflow_id']),
		invocationId:
			row['invocation_id'] == null ? null : String(row['invocation_id']),
		sessionId: row['session_id'] == null ? null : String(row['session_id']),
		idempotencyKey:
			row['idempotency_key'] == null ? null : String(row['idempotency_key']),
		parentRunId:
			row['parent_run_id'] == null ? null : String(row['parent_run_id']),
		startedAt: String(row['started_at']),
		finishedAt: row['finished_at'] == null ? null : String(row['finished_at']),
		durationMs:
			row['duration_ms'] == null ? null : Number(row['duration_ms']) || 0,
		errorName: row['error_name'] == null ? null : String(row['error_name']),
		errorMessage:
			row['error_message'] == null ? null : String(row['error_message']),
		errorTriage: rawTriage && isRunErrorTriage(rawTriage) ? rawTriage : null,
		triageNote: row['triage_note'] == null ? null : String(row['triage_note']),
		triagedAt: row['triaged_at'] == null ? null : String(row['triaged_at']),
		triagedBy: row['triaged_by'] == null ? null : String(row['triaged_by']),
		metadata: parseJsonRecord(row['metadata_json']),
		logCount,
	}
}

function mapLogRow(row: Record<string, SqlStorageValue>): RunRecordLog {
	return {
		runId: String(row['run_id']),
		sequence: Number(row['sequence']) || 0,
		level: String(row['level']) as RunLogLevel,
		message: String(row['message']),
		fields:
			row['fields_json'] == null ? null : parseJsonRecord(row['fields_json']),
	}
}

function mapInvocationLedgerRow(
	row: Record<string, SqlStorageValue>,
): PackageInvocationLedgerRecord {
	const status = String(row['status'] ?? '')
	return {
		id: String(row['id']),
		tokenId: String(row['token_id']),
		packageId: String(row['package_id']),
		packageKodyId: String(row['package_kody_id']),
		exportName: String(row['export_name']),
		idempotencyKey: String(row['idempotency_key']),
		requestHash: String(row['request_hash']),
		source: row['source'] == null ? null : String(row['source']),
		topic: row['topic'] == null ? null : String(row['topic']),
		status: (status === 'completed' || status === 'failed'
			? status
			: 'in_progress') as PackageInvocationLedgerStatus,
		responseJson:
			row['response_json'] == null ? null : String(row['response_json']),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

function mapWorkflowProjectionRow(
	row: Record<string, SqlStorageValue>,
): WorkflowProjectionRecord {
	const rawSourceType = String(row['source_type'] ?? '')
	const sourceType: WorkflowProjectionSourceType =
		rawSourceType === 'inline' ? 'inline' : 'package'
	return {
		id: String(row['id']),
		bindingName: String(row['binding_name']),
		sourceType,
		packageId: row['package_id'] == null ? null : String(row['package_id']),
		kodyId: row['kody_id'] == null ? null : String(row['kody_id']),
		sourceId: row['source_id'] == null ? null : String(row['source_id']),
		workflowName: String(row['workflow_name']),
		exportName: row['export_name'] == null ? null : String(row['export_name']),
		idempotencyKey: String(row['idempotency_key']),
		runAt: String(row['run_at']),
		planDate: row['plan_date'] == null ? null : String(row['plan_date']),
		status: row['status'] == null ? null : String(row['status']),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
		completedAt:
			row['completed_at'] == null ? null : String(row['completed_at']),
		lastError: row['last_error'] == null ? null : String(row['last_error']),
	}
}

function mapJobRunObservabilityRow(
	row: Record<string, SqlStorageValue>,
): JobRunObservabilityRecord {
	const rawStatus = row['last_run_status']
	const lastRunStatus: JobRunObservabilityStatus | null =
		rawStatus === 'success' || rawStatus === 'error' ? rawStatus : null
	return {
		jobId: String(row['job_id']),
		lastRunAt: row['last_run_at'] == null ? null : String(row['last_run_at']),
		lastRunStatus,
		lastRunError:
			row['last_run_error'] == null ? null : String(row['last_run_error']),
		lastDurationMs:
			row['last_duration_ms'] == null
				? null
				: Number(row['last_duration_ms']) || 0,
		runCount: Number(row['run_count'] ?? 0) || 0,
		successCount: Number(row['success_count'] ?? 0) || 0,
		errorCount: Number(row['error_count'] ?? 0) || 0,
		updatedAt: String(row['updated_at']),
	}
}

function mapPackageRunSuccessRow(
	row: Record<string, SqlStorageValue>,
): PackageRunSuccessRecord {
	return {
		packageId: String(row['package_id']),
		successCount: Number(row['success_count'] ?? 0) || 0,
		updatedAt: String(row['updated_at']),
	}
}

function mapActivationMilestoneRow(
	row: Record<string, SqlStorageValue>,
): ActivationMilestoneRecord {
	return {
		milestone: String(row['milestone']) as ActivationMilestone,
		reachedAt: String(row['reached_at']),
		packageId: row['package_id'] == null ? null : String(row['package_id']),
	}
}

function clampMetadataJson(metadataJson: string) {
	if (textEncoder.encode(metadataJson).length <= runRecordMaxJsonBytes) {
		return metadataJson
	}
	return serializeJson(parseJsonRecord(metadataJson))
}

class RunLogBase extends DurableObject<Env> {
	/**
	 * In-isolate cache: once we know an alarm is scheduled, hot finishes skip
	 * getAlarm/setAlarm. Cleared when a pass self-terminates with no rows left
	 * to prune, or when a new `running` insert may need an earlier wake.
	 */
	private retentionAlarmArmed = false
	/**
	 * In-isolate: the DO is empty of future retention work. Cleared on every
	 * startRun/finishRun write so ensureRetentionAlarm re-arms for the new
	 * row's due-time instead of trusting a stale idle conclusion.
	 */
	private retentionIdleConfirmed = false
	/**
	 * In-isolate memo for `run_log_meta` counters. Durable Object handlers are
	 * single-threaded and these keys are only written through setMeta helpers
	 * below, so repeated getRunCount / getFinishesSinceRetention in one jsrpc
	 * (finish → retention → alarm arming) can reuse the loaded value instead of
	 * re-issuing identical SELECTs (Sentry "Inefficient Database Queries").
	 * Cleared on schema init / clearAll so SQL rebuild paths reload fresh.
	 */
	private runCountCache: number | null = null
	private finishesSinceRetentionCache: number | null = null

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		this.ctx.blockConcurrencyWhile(async () => {
			this.initializeSchema()
			this.ensureRunCountMeta()
			// Observe existing alarm only — never arm in the constructor.
			// An unvisited DO never runs (platform constraint); the first write
			// re-converges via ensureRetentionAlarm after clearing idle.
			this.retentionAlarmArmed = (await this.ctx.storage.getAlarm()) != null
		})
	}

	private initializeSchema() {
		// Schema rebuild (clearAll / DR restore / warm-migration tests) may
		// rewrite storage under us; drop counter memos so the next read reloads.
		this.runCountCache = null
		this.finishesSinceRetentionCache = null
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS run_log_meta (
				key TEXT PRIMARY KEY NOT NULL,
				value INTEGER NOT NULL
			)
		`)
		const installedVersion = this.getMeta(metaSchemaVersionKey)
		if (installedVersion === runLogSchemaVersion) return

		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS runs (
				id TEXT PRIMARY KEY NOT NULL,
				surface TEXT NOT NULL,
				status TEXT NOT NULL,
				name TEXT,
				package_id TEXT,
				package_kody_id TEXT,
				source_id TEXT,
				published_commit TEXT,
				storage_id TEXT,
				job_id TEXT,
				workflow_id TEXT,
				invocation_id TEXT,
				session_id TEXT,
				idempotency_key TEXT,
				parent_run_id TEXT,
				started_at TEXT NOT NULL,
				finished_at TEXT,
				duration_ms INTEGER,
				error_name TEXT,
				error_message TEXT,
				metadata_json TEXT NOT NULL DEFAULT '{}',
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				error_triage TEXT,
				triage_note TEXT,
				triaged_at TEXT,
				triaged_by TEXT
			)
		`)
		if (installedVersion != null && installedVersion < 10) {
			this.migrateRunsErrorTriageForV10()
		}
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC, id DESC)`,
		)
		// Replace pre-id composites so keyset list filters can use covering indexes.
		this.ctx.storage.sql.exec(`DROP INDEX IF EXISTS idx_runs_surface_started`)
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_runs_surface_started_id ON runs(surface, started_at DESC, id DESC)`,
		)
		this.ctx.storage.sql.exec(`DROP INDEX IF EXISTS idx_runs_status_started`)
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_runs_status_started_id ON runs(status, started_at DESC, id DESC)`,
		)
		this.ctx.storage.sql.exec(`DROP INDEX IF EXISTS idx_runs_job_started`)
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_runs_job_started_id ON runs(job_id, started_at DESC, id DESC)`,
		)
		this.ctx.storage.sql.exec(`DROP INDEX IF EXISTS idx_runs_package_started`)
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_runs_package_started_id ON runs(package_id, started_at DESC, id DESC)`,
		)
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_runs_name_started_id ON runs(name, started_at DESC, id DESC)`,
		)
		// Non-unique: package invocations / workflows may reuse the same
		// idempotency key across history. Keyed execute claim/replay stays
		// race-free because claimRun select-then-insert runs in one DO RPC.
		// Drop any unique index from schema v3 so warm objects can migrate.
		this.ctx.storage.sql.exec(`DROP INDEX IF EXISTS idx_runs_idempotency_key`)
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_runs_idempotency_key
			ON runs(idempotency_key) WHERE idempotency_key IS NOT NULL`,
		)
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS run_logs (
				run_id TEXT NOT NULL,
				sequence INTEGER NOT NULL,
				level TEXT NOT NULL,
				message TEXT NOT NULL,
				fields_json TEXT,
				PRIMARY KEY (run_id, sequence)
			)
		`)
		// Keyed package-invocation idempotency ledger (migrated from the D1
		// package_invocations table). No user_id column: the DO identity is the
		// user. The unique index is the exactly-once claim scope; unlike D1's
		// INSERT OR IGNORE it never races because DO execution is serialized.
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS package_invocation_ledger (
				id TEXT PRIMARY KEY NOT NULL,
				token_id TEXT NOT NULL,
				package_id TEXT NOT NULL,
				package_kody_id TEXT NOT NULL,
				export_name TEXT NOT NULL,
				idempotency_key TEXT NOT NULL,
				request_hash TEXT NOT NULL,
				source TEXT,
				topic TEXT,
				status TEXT NOT NULL,
				response_json TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)
		`)
		this.ctx.storage.sql.exec(
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_invocation_ledger_key
			ON package_invocation_ledger(token_id, package_id, export_name, idempotency_key)`,
		)
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_invocation_ledger_status_created
			ON package_invocation_ledger(status, created_at ASC)`,
		)
		// Dedicated unpruned workflow projections (binding_name scopes concurrent
		// occupancy per Cloudflare Workflow binding). Correctness state for
		// idempotency and concurrent_workflows — never derived from pruned runs.
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS workflow_projections (
				id TEXT PRIMARY KEY NOT NULL,
				binding_name TEXT NOT NULL,
				source_type TEXT NOT NULL CHECK (source_type IN ('package', 'inline')),
				package_id TEXT,
				kody_id TEXT,
				source_id TEXT,
				workflow_name TEXT NOT NULL,
				export_name TEXT,
				idempotency_key TEXT NOT NULL,
				run_at TEXT NOT NULL,
				plan_date TEXT,
				status TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				completed_at TEXT,
				last_error TEXT
			)
		`)
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_workflow_projections_created
			ON workflow_projections(created_at DESC, id DESC)`,
		)
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_workflow_projections_status
			ON workflow_projections(status)`,
		)
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_workflow_projections_idempotency
			ON workflow_projections(idempotency_key, created_at ASC)`,
		)
		// Dedicated unpruned per-job last-run outcome + counters. Not runs.
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS job_run_observability (
				job_id TEXT PRIMARY KEY NOT NULL,
				last_run_at TEXT,
				last_run_status TEXT,
				last_run_error TEXT,
				last_duration_ms INTEGER,
				run_count INTEGER NOT NULL DEFAULT 0,
				success_count INTEGER NOT NULL DEFAULT 0,
				error_count INTEGER NOT NULL DEFAULT 0,
				updated_at TEXT NOT NULL
			)
		`)
		if (installedVersion != null && installedVersion < 9) {
			this.rebuildJobRunObservabilityForV9()
		}
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_workflow_projections_binding_idempotency
			ON workflow_projections(binding_name, idempotency_key, created_at ASC)`,
		)
		// Dedicated unpruned package activation counters + milestones.
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS package_run_successes (
				package_id TEXT PRIMARY KEY NOT NULL,
				success_count INTEGER NOT NULL CHECK (success_count >= 0),
				updated_at TEXT NOT NULL
			)
		`)
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS activation_milestones (
				milestone TEXT PRIMARY KEY NOT NULL CHECK (
					milestone IN ('package_run_succeeded', 'package_activated')
				),
				reached_at TEXT NOT NULL,
				package_id TEXT
			)
		`)
		this.setMeta(metaSchemaVersionKey, runLogSchemaVersion)
	}

	private rebuildJobRunObservabilityForV9() {
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec(
				`CREATE TABLE job_run_observability_v9 (
					job_id TEXT PRIMARY KEY NOT NULL,
					last_run_at TEXT,
					last_run_status TEXT,
					last_run_error TEXT,
					last_duration_ms INTEGER,
					run_count INTEGER NOT NULL DEFAULT 0,
					success_count INTEGER NOT NULL DEFAULT 0,
					error_count INTEGER NOT NULL DEFAULT 0,
					updated_at TEXT NOT NULL
				)`,
			)
			this.ctx.storage.sql.exec(
				`INSERT INTO job_run_observability_v9 (
					job_id, last_run_at, last_run_status, last_run_error,
					last_duration_ms, run_count, success_count, error_count, updated_at
				)
				SELECT
					job_id, last_run_at, last_run_status, last_run_error,
					last_duration_ms, run_count, success_count, error_count, updated_at
				FROM job_run_observability`,
			)
			this.ctx.storage.sql.exec(`DROP TABLE job_run_observability`)
			this.ctx.storage.sql.exec(
				`ALTER TABLE job_run_observability_v9 RENAME TO job_run_observability`,
			)
		})
	}

	/**
	 * Soft error-triage columns for Activity noise control. Warm objects may
	 * already have these columns when CREATE TABLE IF NOT EXISTS ran against
	 * the current DDL before the version gate called this helper — ignore
	 * duplicate-column errors so re-entry stays idempotent.
	 */
	private migrateRunsErrorTriageForV10() {
		for (const column of [
			'error_triage',
			'triage_note',
			'triaged_at',
			'triaged_by',
		] as const) {
			try {
				this.ctx.storage.sql.exec(`ALTER TABLE runs ADD COLUMN ${column} TEXT`)
			} catch {
				// Column already present on a partially migrated object.
			}
		}
	}

	private getMeta(key: string): number | null {
		const row = this.ctx.storage.sql
			.exec<{ value: number }>(
				`SELECT value FROM run_log_meta WHERE key = ? LIMIT 1`,
				key,
			)
			.toArray()[0]
		return row == null ? null : Number(row.value) || 0
	}

	private setMeta(key: string, value: number) {
		this.ctx.storage.sql.exec(
			`INSERT INTO run_log_meta (key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			key,
			value,
		)
		if (key === metaRunCountKey) this.runCountCache = value
		if (key === metaFinishesSinceRetentionKey) {
			this.finishesSinceRetentionCache = value
		}
	}

	/**
	 * `setMeta` updates counter memos eagerly so hot paths skip re-SELECTs.
	 * When those writes run inside `transactionSync`, a later failure rolls
	 * SQL back but would leave the memos ahead of storage — drop them before
	 * rethrowing so the next read reloads.
	 */
	private transactionSyncWithMetaCache<T>(fn: () => T): T {
		try {
			return this.ctx.storage.transactionSync(fn)
		} catch (error) {
			this.runCountCache = null
			this.finishesSinceRetentionCache = null
			throw error
		}
	}

	private ensureRunCountMeta() {
		const existing = this.getMeta(metaRunCountKey)
		if (existing != null) {
			this.runCountCache = existing
			return
		}
		const countRow = this.ctx.storage.sql
			.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM runs`)
			.one()
		const count = Number(countRow.n ?? 0) || 0
		this.setMeta(metaRunCountKey, count)
		this.setMeta(metaFinishesSinceRetentionKey, 0)
	}

	private getRunCount() {
		if (this.runCountCache == null) {
			this.runCountCache = this.getMeta(metaRunCountKey) ?? 0
		}
		return this.runCountCache
	}

	private adjustRunCount(delta: number) {
		if (delta === 0) return
		this.setMeta(metaRunCountKey, Math.max(0, this.getRunCount() + delta))
	}

	private getFinishesSinceRetention() {
		if (this.finishesSinceRetentionCache == null) {
			this.finishesSinceRetentionCache =
				this.getMeta(metaFinishesSinceRetentionKey) ?? 0
		}
		return this.finishesSinceRetentionCache
	}

	private setFinishesSinceRetention(value: number) {
		this.setMeta(metaFinishesSinceRetentionKey, value)
	}

	private runExists(runId: string) {
		const row = this.ctx.storage.sql
			.exec<{ ok: number }>(
				`SELECT 1 AS ok FROM runs WHERE id = ? LIMIT 1`,
				runId,
			)
			.toArray()[0]
		return row != null
	}

	private findRunByIdempotencyKey(input: {
		idempotencyKey: string
		surface?: RunSurface | null
	}): RunRecord | null {
		// Prefer an in-flight row, then the newest terminal row, so execute
		// replay sees the attempt that still owns the key. Scope by surface
		// when provided so execute keys cannot collide with package/workflow
		// history that reused the same string.
		const clauses = ['r.idempotency_key = ?']
		const params: Array<SqlStorageValue> = [input.idempotencyKey]
		if (input.surface) {
			clauses.push('r.surface = ?')
			params.push(input.surface)
		}
		const row = this.ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT r.*,
					(SELECT COUNT(*) FROM run_logs l WHERE l.run_id = r.id) AS log_count
				FROM runs r
				WHERE ${clauses.join(' AND ')}
				ORDER BY (r.status = 'running') DESC, r.started_at DESC, r.id DESC
				LIMIT 1`,
				...params,
			)
			.toArray()[0]
		if (!row) return null
		return mapRunRow(row, Number(row['log_count'] ?? 0) || 0)
	}

	private insertRunningRun(run: RunLogRowInput) {
		const existed = this.runExists(run.id)
		if (!existed) {
			this.upsertRun(run, 'ignore')
			// INSERT OR IGNORE: count only when the row is new.
			if (this.runExists(run.id)) {
				this.adjustRunCount(1)
				// New row ⇒ future age/stale work exists; idle conclusion is stale.
				// Clear armed too: a new `running` row may need an earlier wake.
				this.retentionIdleConfirmed = false
				this.retentionAlarmArmed = false
			}
		}
	}

	private upsertRun(run: RunLogRowInput, mode: 'ignore' | 'replace') {
		const metadataJson = clampMetadataJson(run.metadataJson || '{}')
		// New rows start with open triage (NULL). On conflict, preserve soft
		// triage for error finishes; clear it when the terminal status is not
		// error so success/running rows never stay hidden behind stale triage.
		const statement =
			mode === 'ignore'
				? `INSERT OR IGNORE INTO runs (
					id, surface, status, name, package_id, package_kody_id, source_id,
					published_commit, storage_id, job_id, workflow_id, invocation_id,
					session_id, idempotency_key, parent_run_id, started_at, finished_at,
					duration_ms, error_name, error_message, metadata_json, created_at,
					updated_at, error_triage, triage_note, triaged_at, triaged_by
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`
				: `INSERT INTO runs (
					id, surface, status, name, package_id, package_kody_id, source_id,
					published_commit, storage_id, job_id, workflow_id, invocation_id,
					session_id, idempotency_key, parent_run_id, started_at, finished_at,
					duration_ms, error_name, error_message, metadata_json, created_at,
					updated_at, error_triage, triage_note, triaged_at, triaged_by
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)
				ON CONFLICT(id) DO UPDATE SET
					surface = excluded.surface,
					status = excluded.status,
					name = excluded.name,
					package_id = excluded.package_id,
					package_kody_id = excluded.package_kody_id,
					source_id = excluded.source_id,
					published_commit = excluded.published_commit,
					storage_id = excluded.storage_id,
					job_id = excluded.job_id,
					workflow_id = excluded.workflow_id,
					invocation_id = excluded.invocation_id,
					session_id = excluded.session_id,
					idempotency_key = excluded.idempotency_key,
					parent_run_id = excluded.parent_run_id,
					started_at = excluded.started_at,
					finished_at = excluded.finished_at,
					duration_ms = excluded.duration_ms,
					error_name = excluded.error_name,
					error_message = excluded.error_message,
					metadata_json = excluded.metadata_json,
					updated_at = excluded.updated_at,
					error_triage = CASE
						WHEN excluded.status = 'error' THEN runs.error_triage
						ELSE NULL
					END,
					triage_note = CASE
						WHEN excluded.status = 'error' THEN runs.triage_note
						ELSE NULL
					END,
					triaged_at = CASE
						WHEN excluded.status = 'error' THEN runs.triaged_at
						ELSE NULL
					END,
					triaged_by = CASE
						WHEN excluded.status = 'error' THEN runs.triaged_by
						ELSE NULL
					END`
		this.ctx.storage.sql.exec(
			statement,
			run.id,
			run.surface,
			run.status,
			run.name,
			run.packageId,
			run.kodyId,
			run.sourceId,
			run.publishedCommit,
			run.storageId,
			run.jobId,
			run.workflowId,
			run.invocationId,
			run.sessionId,
			run.idempotencyKey,
			run.parentRunId,
			run.startedAt,
			run.finishedAt,
			run.durationMs,
			run.errorName,
			run.errorMessage,
			metadataJson,
			run.createdAt,
			run.updatedAt,
		)
	}

	private replaceLogs(runId: string, logs: Array<RunLogEntryInput>) {
		this.ctx.storage.sql.exec(`DELETE FROM run_logs WHERE run_id = ?`, runId)
		const kept = logs.slice(-runRecordMaxLogEntriesPerRun)
		for (const [index, log] of kept.entries()) {
			const message = truncateUtf8(String(log.message), runRecordMaxTextBytes)
			const fieldsJson =
				log.fieldsJson == null
					? null
					: clampMetadataJson(String(log.fieldsJson))
			this.ctx.storage.sql.exec(
				`INSERT INTO run_logs (run_id, sequence, level, message, fields_json)
				VALUES (?, ?, ?, ?, ?)`,
				runId,
				index,
				log.level,
				message,
				fieldsJson,
			)
		}
	}

	private deleteRunsByIds(ids: Array<string>) {
		for (const id of ids) {
			this.ctx.storage.sql.exec(`DELETE FROM run_logs WHERE run_id = ?`, id)
			this.ctx.storage.sql.exec(`DELETE FROM runs WHERE id = ?`, id)
		}
		this.adjustRunCount(-ids.length)
	}

	private isStaleRunning(input: {
		surface: string
		startedAt: string
		nowMs?: number
	}): boolean {
		const surface = isRunSurface(input.surface) ? input.surface : 'execute'
		const startedMs = Date.parse(input.startedAt)
		if (!Number.isFinite(startedMs)) return false
		const nowMs = input.nowMs ?? Date.now()
		return nowMs - startedMs >= runRecordStaleRunningTtlMsForSurface(surface)
	}

	private markRunningInterrupted(input: {
		id: string
		startedAt: string
		finishedAt?: string
	}) {
		const finishedAt = input.finishedAt ?? new Date().toISOString()
		const startedMs = Date.parse(input.startedAt)
		const finishedMs = Date.parse(finishedAt)
		const durationMs =
			Number.isFinite(startedMs) && Number.isFinite(finishedMs)
				? Math.max(0, finishedMs - startedMs)
				: null
		this.ctx.storage.sql.exec(
			`UPDATE runs
			SET status = 'error',
				finished_at = ?,
				duration_ms = ?,
				error_name = ?,
				error_message = ?,
				updated_at = ?
			WHERE id = ? AND status = 'running'`,
			finishedAt,
			durationMs,
			staleRunningErrorName,
			staleRunningErrorMessage,
			finishedAt,
			input.id,
		)
		// Row became terminal: age-prune now applies, so any prior idle
		// conclusion is stale (covers reconcile + heal-on-read callers).
		this.retentionIdleConfirmed = false
	}

	/**
	 * Prefer marking stranded `running` rows terminal over deleting them: an
	 * interrupted attempt is useful history. `error` + Interrupted is used
	 * because the public status union has no dedicated unknown-outcome value;
	 * live "is it running?" state must not be read from these rows anyway.
	 *
	 * TTL is surface-aware: sandbox-backed surfaces (execute/export/…) heal in
	 * minutes; long-lived service/workflow rows keep the day-scale TTL.
	 */
	private reconcileStaleRunning() {
		const nowMs = Date.now()
		const finishedAt = new Date(nowMs).toISOString()
		// Per-surface cutoffs so long-lived job/service rows cannot fill the
		// batch and starve short-lived execute/export rows that are already
		// past their 3-minute TTL.
		const shortLivedCutoff = new Date(
			nowMs - runRecordStaleRunningTtlMsForSurface('execute'),
		).toISOString()
		const jobCutoff = new Date(
			nowMs - runRecordStaleRunningTtlMsForSurface('job'),
		).toISOString()
		const longLivedCutoff = new Date(
			nowMs - runRecordStaleRunningTtlMsForSurface('service'),
		).toISOString()
		const candidates = this.ctx.storage.sql
			.exec<{ id: string; started_at: string; surface: string }>(
				`SELECT id, started_at, surface FROM runs
				WHERE status = 'running' AND (
					(surface IN ('execute', 'export', 'retriever', 'webhook', 'subscription', 'app_fetch', 'app_realtime')
						AND started_at < ?)
					OR (surface = 'job' AND started_at < ?)
					OR (surface IN ('service', 'workflow') AND started_at < ?)
				)
				ORDER BY started_at ASC
				LIMIT ?`,
				shortLivedCutoff,
				jobCutoff,
				longLivedCutoff,
				maxStaleRunningReconcilesPerPass,
			)
			.toArray()
		let reconciled = 0
		for (const row of candidates) {
			if (
				!this.isStaleRunning({
					surface: row.surface,
					startedAt: row.started_at,
					nowMs,
				})
			) {
				continue
			}
			this.markRunningInterrupted({
				id: row.id,
				startedAt: row.started_at,
				finishedAt,
			})
			reconciled += 1
		}
		return reconciled
	}

	/**
	 * Heal one still-`running` row when a reader observes it past its surface
	 * TTL. Keeps Activity / keyed-execute recovery honest even when the DO
	 * alarm has not fired yet (unvisited objects, sticky armed alarms).
	 */
	private healStaleRunningRecord(run: RunRecord): RunRecord {
		if (run.status !== 'running') return run
		if (
			!this.isStaleRunning({
				surface: run.surface,
				startedAt: run.startedAt,
			})
		) {
			return run
		}
		this.markRunningInterrupted({
			id: run.id,
			startedAt: run.startedAt,
		})
		const healed = this.ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT r.*,
					(SELECT COUNT(*) FROM run_logs l WHERE l.run_id = r.id) AS log_count
				FROM runs r
				WHERE r.id = ?
				LIMIT 1`,
				run.id,
			)
			.toArray()[0]
		if (!healed) return run
		return mapRunRow(healed, Number(healed['log_count'] ?? 0) || 0)
	}

	private deleteOldestMatching(
		status: RunStatus,
		triage: 'triaged' | 'open' | null,
		limit: number,
	) {
		if (limit <= 0) return [] as Array<string>
		const triageClause =
			triage === 'triaged'
				? 'AND error_triage IS NOT NULL'
				: triage === 'open'
					? 'AND error_triage IS NULL'
					: ''
		return this.ctx.storage.sql
			.exec<{ id: string }>(
				`SELECT id FROM runs
				WHERE status = ? ${triageClause}
				ORDER BY started_at ASC
				LIMIT ?`,
				status,
				limit,
			)
			.toArray()
			.map((row) => row.id)
	}

	/**
	 * Arming rule (keep this comment accurate — reviewers rely on it):
	 *
	 * - Schedule at most one alarm for the soonest retention due-time:
	 *   over-cap → now; oldest finished → started_at + retention; oldest
	 *   running → started_at + stale TTL. Empty DOs stay disarmed.
	 * - `retentionAlarmArmed` skips getAlarm/setAlarm on hot finishes once
	 *   scheduled (over-cap still forces a near-term resync).
	 * - `retentionIdleConfirmed` skips re-evaluation only while no new row
	 *   has been written; every startRun/finishRun write clears it so the
	 *   next ensure re-arms for that row's future due-time.
	 * - alarm() self-terminates only when nothing remains to ever prune;
	 *   otherwise it reschedules for the next due-time (not hourly forever).
	 * - An unvisited DO never runs (platform constraint). Cold start observes
	 *   any existing alarm; the first write re-converges via ensure.
	 */
	private nextRetentionDueAtMs(): number | null {
		if (this.getRunCount() > runRecordMaxRunsPerUser) {
			return Date.now()
		}

		let next: number | null = null
		const consider = (at: number) => {
			if (!Number.isFinite(at)) return
			if (next == null || at < next) next = at
		}

		const oldestFinished = this.ctx.storage.sql
			.exec<{ started_at: string }>(
				`SELECT started_at FROM runs
				WHERE status != 'running'
				ORDER BY started_at ASC
				LIMIT 1`,
			)
			.toArray()[0]
		if (oldestFinished) {
			consider(Date.parse(oldestFinished.started_at) + retentionMs)
		}

		const oldestTerminalLedgerRow = this.ctx.storage.sql
			.exec<{ created_at: string }>(
				`SELECT created_at FROM package_invocation_ledger
				WHERE status != 'in_progress'
				ORDER BY created_at ASC
				LIMIT 1`,
			)
			.toArray()[0]
		if (oldestTerminalLedgerRow) {
			consider(
				Date.parse(oldestTerminalLedgerRow.created_at) + ledgerRetentionMs,
			)
		}

		const terminalPlaceholders = workflowProjectionTerminalStatuses
			.map(() => '?')
			.join(', ')
		const oldestTerminalWorkflowProjection = this.ctx.storage.sql
			.exec<{ due_at: string }>(
				`SELECT COALESCE(completed_at, updated_at) AS due_at
				FROM workflow_projections
				WHERE status IN (${terminalPlaceholders})
				ORDER BY COALESCE(completed_at, updated_at) ASC
				LIMIT 1`,
				...workflowProjectionTerminalStatuses,
			)
			.toArray()[0]
		if (oldestTerminalWorkflowProjection) {
			consider(
				Date.parse(oldestTerminalWorkflowProjection.due_at) +
					workflowProjectionRetentionMs,
			)
		}

		const oldestStaleCreatingProjection = this.ctx.storage.sql
			.exec<{ updated_at: string }>(
				`SELECT updated_at FROM workflow_projections
				WHERE COALESCE(status, '') = ?
				ORDER BY updated_at ASC
				LIMIT 1`,
				creatingWorkflowProjectionStatus,
			)
			.toArray()[0]
		if (oldestStaleCreatingProjection) {
			consider(
				Date.parse(oldestStaleCreatingProjection.updated_at) +
					workflowProjectionCreatingTtlMs,
			)
		}

		// Soonest stale due-time can belong to a newer short-lived surface
		// (execute) even when an older long-lived service/job row exists.
		// Only the earliest row per surface can produce that due-time.
		const oldestRunningPerSurface = this.ctx.storage.sql
			.exec<{ surface: string; started_at: string }>(
				`SELECT surface, MIN(started_at) AS started_at FROM runs
				WHERE status = 'running'
				GROUP BY surface`,
			)
			.toArray()
		for (const row of oldestRunningPerSurface) {
			const surface = isRunSurface(row.surface) ? row.surface : 'execute'
			consider(
				Date.parse(row.started_at) +
					runRecordStaleRunningTtlMsForSurface(surface),
			)
		}

		return next
	}

	private enforceRetention() {
		// Reconcile first so stranded `running` rows become terminal `error`
		// before the count cap runs — that is how a cap full of in-flight rows
		// still converges once they pass the stale TTL.
		this.reconcileStaleRunning()

		const cutoff = new Date(Date.now() - retentionMs).toISOString()
		const expired = this.ctx.storage.sql
			.exec<{ id: string }>(
				`SELECT id FROM runs
				WHERE started_at < ? AND status != 'running'
				ORDER BY started_at ASC
				LIMIT ?`,
				cutoff,
				maxAgeDeletesPerFinish,
			)
			.toArray()
			.map((row) => row.id)
		this.deleteRunsByIds(expired)

		const total = this.getRunCount()
		const excess = total - runRecordMaxRunsPerUser
		if (excess > 0) {
			const deleteCount = Math.min(excess, maxExcessDeletesPerFinish)
			// In-flight rows are never cap-evicted (same as age prune). Handled
			// errors go first, then successes, with open errors retained last.
			// This makes soft triage relieve saturation without sacrificing
			// useful successful history. Stale `running` becomes evictable only
			// after reconcile demotes it to an open `error` above.
			// Genuinely in-flight rows can therefore push the stored count
			// briefly above runRecordMaxRunsPerUser until they finish or go
			// stale — that is intentional, not a broken cap.
			const ids: Array<string> = []
			ids.push(...this.deleteOldestMatching('error', 'triaged', deleteCount))
			if (ids.length < deleteCount) {
				ids.push(
					...this.deleteOldestMatching(
						'success',
						null,
						deleteCount - ids.length,
					),
				)
			}
			if (ids.length < deleteCount) {
				ids.push(
					...this.deleteOldestMatching(
						'error',
						'open',
						deleteCount - ids.length,
					),
				)
			}
			this.deleteRunsByIds(ids)
		}

		this.pruneInvocationLedgerForRetention()
		this.pruneWorkflowProjectionsForRetention()
		this.setFinishesSinceRetention(0)
	}

	/**
	 * DO-local replacement for the D1 `package_invocations` retention sweep:
	 * terminal ledger rows keep their replay responses for 90 days;
	 * `in_progress` rows are never pruned so duplicate requests cannot bypass
	 * the in-flight guard. Batched so one retention pass stays bounded.
	 */
	private pruneInvocationLedgerForRetention() {
		const cutoff = new Date(Date.now() - ledgerRetentionMs).toISOString()
		this.ctx.storage.sql.exec(
			`DELETE FROM package_invocation_ledger
			WHERE id IN (
				SELECT id FROM package_invocation_ledger
				WHERE status != 'in_progress' AND created_at < ?
				ORDER BY created_at ASC
				LIMIT ?
			)`,
			cutoff,
			maxLedgerAgeDeletesPerPass,
		)
	}

	/**
	 * Age-prune terminal workflow projections after 90 days and drop stale
	 * `creating` reservations past their short TTL. Active/running rows are
	 * never removed. Success counts, milestones, and job observability are
	 * intentionally absent from this lane.
	 */
	private pruneWorkflowProjectionsForRetention() {
		this.pruneStaleCreatingWorkflowProjections()
		const cutoff = new Date(
			Date.now() - workflowProjectionRetentionMs,
		).toISOString()
		const placeholders = workflowProjectionTerminalStatuses
			.map(() => '?')
			.join(', ')
		this.ctx.storage.sql.exec(
			`DELETE FROM workflow_projections
			WHERE id IN (
				SELECT id FROM workflow_projections
				WHERE status IN (${placeholders})
					AND COALESCE(completed_at, updated_at) < ?
				ORDER BY COALESCE(completed_at, updated_at) ASC
				LIMIT ?
			)`,
			...workflowProjectionTerminalStatuses,
			cutoff,
			maxWorkflowProjectionAgeDeletesPerPass,
		)
	}

	/** Drop `creating` rows whose `updated_at` is older than the creating TTL. */
	private pruneStaleCreatingWorkflowProjections() {
		const cutoff = new Date(
			Date.now() - workflowProjectionCreatingTtlMs,
		).toISOString()
		this.ctx.storage.sql.exec(
			`DELETE FROM workflow_projections
			WHERE id IN (
				SELECT id FROM workflow_projections
				WHERE COALESCE(status, '') = ?
					AND updated_at < ?
				ORDER BY updated_at ASC
				LIMIT ?
			)`,
			creatingWorkflowProjectionStatus,
			cutoff,
			maxStaleCreatingDeletesPerPass,
		)
	}

	private maybeEnforceRetention() {
		const finishes = this.getFinishesSinceRetention() + 1
		this.setFinishesSinceRetention(finishes)
		if (finishes >= runRecordRetentionEveryNFinishes) {
			this.enforceRetention()
		}
	}

	private async ensureRetentionAlarm() {
		const overCap = this.getRunCount() > runRecordMaxRunsPerUser
		if (this.retentionAlarmArmed && !overCap) return
		if (!this.retentionAlarmArmed && this.retentionIdleConfirmed && !overCap) {
			return
		}

		const next = this.nextRetentionDueAtMs()
		if (next == null) {
			this.retentionIdleConfirmed = true
			this.retentionAlarmArmed = false
			return
		}

		this.retentionIdleConfirmed = false
		const alarmAt = Math.max(next, Date.now() + 1_000)
		const existing = await this.ctx.storage.getAlarm()
		if (
			existing != null &&
			Math.abs(existing - alarmAt) < runRecordRetentionAlarmMs
		) {
			this.retentionAlarmArmed = true
			return
		}
		await this.ctx.storage.setAlarm(alarmAt)
		this.retentionAlarmArmed = true
	}

	async alarm(): Promise<void> {
		this.enforceRetention()
		const next = this.nextRetentionDueAtMs()
		if (next == null) {
			this.retentionAlarmArmed = false
			this.retentionIdleConfirmed = true
			return
		}
		await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1_000))
		this.retentionAlarmArmed = true
		this.retentionIdleConfirmed = false
	}

	async getRecoveryBookmark(input: {
		timestampMs: number
	}): Promise<{ bookmark: string }> {
		return await getRecoveryBookmark(this.ctx, input, {
			environment: this.env,
		})
	}

	async restoreToBookmark(input: {
		bookmark: string
	}): Promise<{ undoBookmark: string }> {
		return await restoreToBookmark(this.ctx, input, {
			objectKind: 'run-log',
			environment: this.env,
		})
	}

	async startRun(input: { run: RunLogRowInput }): Promise<{ ok: true }> {
		this.insertRunningRun(input.run)
		await this.ensureRetentionAlarm()
		return { ok: true }
	}

	/**
	 * Atomically claim an idempotency key (or return the existing owner). DO
	 * RPCs are serialized, so select-then-insert here is race-free without a
	 * separate lock. Callers that need keyed execute replay use this instead of
	 * fire-and-forget `startRun`.
	 */
	async claimRun(input: { run: RunLogRowInput }): Promise<{
		claimed: boolean
		run: RunRecord
	}> {
		const key = input.run.idempotencyKey?.trim() || null
		if (key) {
			const existing = this.findRunByIdempotencyKey({
				idempotencyKey: key,
				surface: input.run.surface,
			})
			if (existing) {
				// Heal stranded `running` owners before refusing the claim so a
				// keyed retry after an isolate death is not stuck on inProgress
				// forever. Terminal rows (including reconciled Interrupted)
				// still own the key for replay.
				return {
					claimed: false,
					run: this.healStaleRunningRecord(existing),
				}
			}
		}
		this.insertRunningRun(input.run)
		await this.ensureRetentionAlarm()
		const inserted =
			(await this.getRun({ runId: input.run.id }))?.run ??
			mapRunRow(
				{
					id: input.run.id,
					surface: input.run.surface,
					status: input.run.status,
					name: input.run.name,
					package_id: input.run.packageId,
					package_kody_id: input.run.kodyId,
					source_id: input.run.sourceId,
					published_commit: input.run.publishedCommit,
					storage_id: input.run.storageId,
					job_id: input.run.jobId,
					workflow_id: input.run.workflowId,
					invocation_id: input.run.invocationId,
					session_id: input.run.sessionId,
					idempotency_key: input.run.idempotencyKey,
					parent_run_id: input.run.parentRunId,
					started_at: input.run.startedAt,
					finished_at: input.run.finishedAt,
					duration_ms: input.run.durationMs,
					error_name: input.run.errorName,
					error_message: input.run.errorMessage,
					metadata_json: input.run.metadataJson,
				},
				0,
			)
		return { claimed: true, run: inserted }
	}

	async getRunByIdempotencyKey(input: {
		idempotencyKey: string
		surface?: RunSurface | null
	}): Promise<RunRecord | null> {
		const key = input.idempotencyKey.trim()
		if (!key) return null
		const existing = this.findRunByIdempotencyKey({
			idempotencyKey: key,
			surface: input.surface ?? null,
		})
		if (!existing) return null
		return this.healStaleRunningRecord(existing)
	}

	/**
	 * Delete a still-`running` row (and its logs) so a failed setup path can
	 * release an idempotency key without poisoning later retries.
	 */
	async deleteRunIfRunning(input: {
		runId: string
	}): Promise<{ deleted: boolean }> {
		const row = this.ctx.storage.sql
			.exec<{ status: string }>(
				`SELECT status FROM runs WHERE id = ? LIMIT 1`,
				input.runId,
			)
			.toArray()[0]
		if (!row || row.status !== 'running') {
			return { deleted: false }
		}
		this.deleteRunsByIds([input.runId])
		this.retentionIdleConfirmed = false
		await this.ensureRetentionAlarm()
		return { deleted: true }
	}

	private getRunStatus(runId: string): RunStatus | null {
		const row = this.ctx.storage.sql
			.exec<{ status: string }>(
				`SELECT status FROM runs WHERE id = ? LIMIT 1`,
				runId,
			)
			.toArray()[0]
		if (!row) return null
		const status = String(row.status)
		if (status === 'running' || status === 'success' || status === 'error') {
			return status
		}
		return null
	}

	private hasActivationMilestone(milestone: ActivationMilestone): boolean {
		const row = this.ctx.storage.sql
			.exec<{ ok: number }>(
				`SELECT 1 AS ok FROM activation_milestones WHERE milestone = ? LIMIT 1`,
				milestone,
			)
			.toArray()[0]
		return row != null
	}

	/**
	 * Increment package success counts and write first-success / activated
	 * milestones. Transaction-neutral so callers can wrap it with run upsert +
	 * log replacement in one `transactionSync` (nested transactions are not
	 * supported).
	 *
	 * Legacy contract: once the global `package_activated` milestone exists,
	 * counters and milestones stop changing for every package (short-circuit
	 * before any write). This matches pre-cutover D1 activation semantics.
	 */
	private applySuccessfulPackageActivationIncrement(input: {
		packageId: string
		reachedAt: string
	}) {
		const packageId = input.packageId
		const updatedAt = input.reachedAt
		// Global activation latch: further package successes must not mutate
		// success_count rows or milestones after the user is already activated.
		if (this.hasActivationMilestone('package_activated')) return

		this.ctx.storage.sql.exec(
			`INSERT INTO package_run_successes (package_id, success_count, updated_at)
			VALUES (?, 1, ?)
			ON CONFLICT(package_id) DO UPDATE SET
				success_count = success_count + 1,
				updated_at = excluded.updated_at`,
			packageId,
			updatedAt,
		)
		this.ctx.storage.sql.exec(
			`INSERT OR IGNORE INTO activation_milestones (milestone, reached_at, package_id)
			VALUES ('package_run_succeeded', ?, ?)`,
			updatedAt,
			packageId,
		)
		const countRow = this.ctx.storage.sql
			.exec<{ success_count: number }>(
				`SELECT success_count FROM package_run_successes
				WHERE package_id = ? LIMIT 1`,
				packageId,
			)
			.toArray()[0]
		const successCount = Number(countRow?.success_count ?? 0) || 0
		if (successCount < 2) return
		this.ctx.storage.sql.exec(
			`INSERT OR IGNORE INTO activation_milestones (milestone, reached_at, package_id)
			VALUES ('package_activated', ?, ?)`,
			updatedAt,
			packageId,
		)
	}

	/**
	 * Increment package success counts / milestones for a genuine new terminal
	 * success. Throws on SQL failure so the finish transaction can roll back.
	 */
	private recordSuccessfulPackageActivation(input: {
		packageId: string | null
		surface: string
		reachedAt: string
	}) {
		const packageId = input.packageId?.trim() || null
		if (!packageId) return
		if (!countsTowardPackageActivation(input.surface)) return
		this.applySuccessfulPackageActivationIncrement({
			packageId,
			reachedAt: input.reachedAt,
		})
	}

	private maybeRecordActivationForTerminalRun(input: {
		previousStatus: RunStatus | null
		run: RunLogRowInput
	}) {
		if (input.run.status !== 'success') return
		// Replacement/replay of an already-terminal success must not re-count.
		if (input.previousStatus === 'success') return
		this.recordSuccessfulPackageActivation({
			packageId: input.run.packageId,
			surface: input.run.surface,
			reachedAt:
				input.run.finishedAt ?? input.run.updatedAt ?? new Date().toISOString(),
		})
	}

	/**
	 * Apply one terminal job outcome to `job_run_observability`. Shared by the
	 * public upsert RPC and the finish-path side effect.
	 */
	private writeJobRunObservabilityOutcome(
		input: JobRunObservabilityUpsertInput,
	): JobRunObservabilityRecord {
		const jobId = input.jobId.trim()
		const ranAt = input.ranAt
		const updatedAt = ranAt
		const durationMs =
			typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)
				? Math.max(0, Math.trunc(input.durationMs))
				: null
		const error = input.status === 'error' ? input.error?.trim() || null : null
		const successDelta = input.status === 'success' ? 1 : 0
		const errorDelta = input.status === 'error' ? 1 : 0
		this.ctx.storage.sql.exec(
			`INSERT INTO job_run_observability (
				job_id, last_run_at, last_run_status, last_run_error, last_duration_ms,
				run_count, success_count, error_count, updated_at
			) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
			ON CONFLICT(job_id) DO UPDATE SET
				last_run_at = excluded.last_run_at,
				last_run_status = excluded.last_run_status,
				last_run_error = excluded.last_run_error,
				last_duration_ms = excluded.last_duration_ms,
				run_count = run_count + 1,
				success_count = success_count + excluded.success_count,
				error_count = error_count + excluded.error_count,
				updated_at = excluded.updated_at`,
			jobId,
			ranAt,
			input.status,
			error,
			durationMs,
			successDelta,
			errorDelta,
			updatedAt,
		)
		const row = this.ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM job_run_observability WHERE job_id = ? LIMIT 1`,
				jobId,
			)
			.toArray()[0]
		if (!row) {
			throw new Error(
				`job_run_observability row missing after upsert: ${jobId}`,
			)
		}
		return mapJobRunObservabilityRow(row)
	}

	/**
	 * Upsert job last-run counters for a genuine new terminal finish with a
	 * `jobId`. Replay/replacement of an already-terminal run must not
	 * double-count. Throws on SQL failure so the finish transaction can roll
	 * back.
	 */
	private maybeRecordJobRunObservabilityForTerminalRun(input: {
		previousStatus: RunStatus | null
		run: RunLogRowInput
	}) {
		if (input.run.status !== 'success' && input.run.status !== 'error') {
			return
		}
		// Already-terminal → terminal replacement/replay: counters stay put.
		if (
			input.previousStatus === 'success' ||
			input.previousStatus === 'error'
		) {
			return
		}
		const jobId = input.run.jobId?.trim() || null
		if (!jobId) return
		const ranAt =
			input.run.finishedAt ?? input.run.updatedAt ?? new Date().toISOString()
		const error =
			input.run.status === 'error'
				? input.run.errorMessage?.trim() || input.run.errorName?.trim() || null
				: null
		this.writeJobRunObservabilityOutcome({
			jobId,
			status: input.run.status,
			ranAt,
			error,
			durationMs: input.run.durationMs,
		})
	}

	private recordTerminalRunSideEffects(input: {
		previousStatus: RunStatus | null
		run: RunLogRowInput
	}) {
		this.maybeRecordActivationForTerminalRun(input)
		this.maybeRecordJobRunObservabilityForTerminalRun(input)
		this.maybeAutoResolvePriorJobErrors(input)
	}

	/**
	 * A later successful attempt is strong evidence that earlier open failures
	 * of the same scheduled job are no longer active. Soft-resolve those rows
	 * without changing their execution status or error details. User-ignored
	 * and already-resolved rows are deliberately left untouched.
	 *
	 * Only job_id is used: other surfaces do not all have an equally strong,
	 * immutable identity, so name-based auto-triage would risk hiding unrelated
	 * failures. The per-user count cap bounds this single UPDATE to 2,000 rows.
	 */
	private maybeAutoResolvePriorJobErrors(input: {
		previousStatus: RunStatus | null
		run: RunLogRowInput
	}) {
		if (
			input.run.status !== 'success' ||
			input.previousStatus === 'success' ||
			input.run.surface !== 'job'
		) {
			return
		}
		const jobId = input.run.jobId?.trim()
		if (!jobId) return
		const triagedAt =
			input.run.finishedAt ?? input.run.updatedAt ?? new Date().toISOString()
		this.ctx.storage.sql.exec(
			`UPDATE runs
			SET error_triage = 'resolved',
				triage_note = 'auto-resolved: later success of the same job',
				triaged_at = ?,
				triaged_by = 'system:auto-resolve',
				updated_at = ?
			WHERE status = 'error'
				AND error_triage IS NULL
				AND surface = 'job'
				AND job_id = ?
				AND id != ?`,
			triagedAt,
			triagedAt,
			jobId,
			input.run.id,
		)
	}

	async finishRun(input: {
		run: RunLogRowInput
		logs: Array<RunLogEntryInput>
	}): Promise<{ ok: true }> {
		const previousStatus = this.getRunStatus(input.run.id)
		const existed = previousStatus != null
		// One transaction for run upsert + logs + job observability + activation
		// so a mid-unit SQL failure cannot leave a terminal run that suppresses
		// missing derived side effects. Alarm / async retention stay outside.
		this.transactionSyncWithMetaCache(() => {
			this.upsertRun(input.run, 'replace')
			this.replaceLogs(input.run.id, input.logs)
			if (!existed) {
				this.adjustRunCount(1)
			}
			this.recordTerminalRunSideEffects({
				previousStatus,
				run: input.run,
			})
		})
		// Any write invalidates idle. Keep `retentionAlarmArmed` so repeated
		// finishes inside an already-scheduled window stay off alarm storage;
		// terminal rows only push age deadlines later.
		this.retentionIdleConfirmed = false
		this.maybeEnforceRetention()
		await this.ensureRetentionAlarm()
		return { ok: true }
	}

	private findInvocationLedgerRow(
		key: PackageInvocationLedgerKey,
	): PackageInvocationLedgerRecord | null {
		const row = this.ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM package_invocation_ledger
				WHERE token_id = ?
					AND package_id = ?
					AND export_name = ?
					AND idempotency_key = ?
				LIMIT 1`,
				key.tokenId,
				key.packageId,
				key.exportName,
				key.idempotencyKey,
			)
			.toArray()[0]
		return row ? mapInvocationLedgerRow(row) : null
	}

	private getInvocationLedgerRowById(
		id: string,
	): PackageInvocationLedgerRecord | null {
		const row = this.ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM package_invocation_ledger WHERE id = ? LIMIT 1`,
				id,
			)
			.toArray()[0]
		return row ? mapInvocationLedgerRow(row) : null
	}

	/**
	 * Claim a keyed package invocation and begin its run record in one on-path
	 * DO call. DO execution is serialized, so lookup-then-insert here is
	 * atomic — strictly better claim semantics than the racy D1
	 * `INSERT OR IGNORE` this replaces. A matching stale `in_progress` row
	 * (same request hash, `updated_at <= staleBefore`) is reclaimed in place;
	 * everything else the key already owns is returned to the caller for
	 * replay / mismatch / in-progress resolution.
	 */
	async claimPackageInvocation(input: {
		invocation: PackageInvocationClaimInput
		/** ISO cutoff: matching `in_progress` rows at or before it are reclaimable. */
		staleBefore: string
		/** Eager `running` run row for this attempt; `null` when the caller owns the run record (workflow-sourced invokes). */
		run: RunLogRowInput | null
	}): Promise<PackageInvocationClaimResult> {
		const now = new Date().toISOString()
		const existing = this.findInvocationLedgerRow(input.invocation)
		if (existing) {
			const reclaimable =
				existing.status === 'in_progress' &&
				existing.requestHash === input.invocation.requestHash &&
				existing.updatedAt <= input.staleBefore
			if (!reclaimable) {
				return { outcome: 'existing', record: existing }
			}
			this.ctx.storage.sql.exec(
				`UPDATE package_invocation_ledger SET updated_at = ? WHERE id = ?`,
				now,
				existing.id,
			)
			if (input.run) {
				this.insertRunningRun({ ...input.run, invocationId: existing.id })
				await this.ensureRetentionAlarm()
			}
			return {
				outcome: 'claimed',
				invocationId: existing.id,
				claimUpdatedAt: now,
				reclaimed: true,
			}
		}
		this.ctx.storage.sql.exec(
			`INSERT INTO package_invocation_ledger (
				id, token_id, package_id, package_kody_id, export_name,
				idempotency_key, request_hash, source, topic, status,
				response_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', NULL, ?, ?)`,
			input.invocation.id,
			input.invocation.tokenId,
			input.invocation.packageId,
			input.invocation.packageKodyId,
			input.invocation.exportName,
			input.invocation.idempotencyKey,
			input.invocation.requestHash,
			input.invocation.source,
			input.invocation.topic,
			now,
			now,
		)
		if (input.run) {
			this.insertRunningRun({
				...input.run,
				invocationId: input.invocation.id,
			})
			await this.ensureRetentionAlarm()
		}
		return {
			outcome: 'claimed',
			invocationId: input.invocation.id,
			claimUpdatedAt: now,
			reclaimed: false,
		}
	}

	async getPackageInvocation(
		input: PackageInvocationLedgerKey,
	): Promise<PackageInvocationLedgerRecord | null> {
		return this.findInvocationLedgerRow(input)
	}

	/**
	 * Store the terminal response and finish the attempt's run record in one
	 * on-path DO call. The ledger update is fenced on `claimUpdatedAt` so a
	 * competing stale reclaim cannot be overwritten; the run row is this
	 * attempt's alone, so it is finished even when the fence fails (the
	 * attempt still happened and must not stay `running` forever).
	 */
	async finishPackageInvocation(input: {
		invocationId: string
		claimUpdatedAt: string
		status: 'completed' | 'failed'
		responseJson: string | null
		run: RunLogRowInput | null
		logs: Array<RunLogEntryInput>
	}): Promise<{
		ledgerUpdated: boolean
		/** Current row when the fence failed, so the caller can resolve it. */
		record: PackageInvocationLedgerRecord | null
	}> {
		const now = new Date().toISOString()
		// Fence + run/log/derived side effects share one transaction so a SQL
		// failure cannot leave a terminal run without its ledger/side effects.
		// Alarm scheduling stays outside.
		let ledgerUpdated = false
		let current: PackageInvocationLedgerRecord | null = null
		this.transactionSyncWithMetaCache(() => {
			current = this.getInvocationLedgerRowById(input.invocationId)
			ledgerUpdated =
				current != null &&
				current.status === 'in_progress' &&
				current.updatedAt === input.claimUpdatedAt
			if (ledgerUpdated) {
				this.ctx.storage.sql.exec(
					`UPDATE package_invocation_ledger
					SET status = ?, response_json = ?, updated_at = ?
					WHERE id = ?`,
					input.status,
					input.responseJson,
					now,
					input.invocationId,
				)
			}
			if (input.run) {
				const previousStatus = this.getRunStatus(input.run.id)
				const existed = previousStatus != null
				this.upsertRun(input.run, 'replace')
				this.replaceLogs(input.run.id, input.logs)
				if (!existed) {
					this.adjustRunCount(1)
				}
				// Activation + job observability follow the run transition, not
				// the ledger fence: the attempt still happened and must count
				// once even when a competing reclaim owns the ledger row.
				this.recordTerminalRunSideEffects({
					previousStatus,
					run: input.run,
				})
			}
		})
		// A terminal ledger row creates future age-prune work even when no run
		// row was written, so a stale idle conclusion must be cleared.
		this.retentionIdleConfirmed = false
		this.maybeEnforceRetention()
		await this.ensureRetentionAlarm()
		if (ledgerUpdated) {
			return { ledgerUpdated: true, record: null }
		}
		return { ledgerUpdated: false, record: current }
	}

	/**
	 * Release a claim whose execution never started so retries are not
	 * poisoned. Deletes the still-`in_progress` ledger row (fenced on
	 * `claimUpdatedAt`) and the attempt's still-`running` run row.
	 */
	async releasePackageInvocation(input: {
		invocationId: string
		claimUpdatedAt: string
		runId: string | null
	}): Promise<{
		released: boolean
		/** Current row when the fence failed, so the caller can resolve it. */
		record: PackageInvocationLedgerRecord | null
	}> {
		// Same explicit read-then-write fence as finishPackageInvocation: DO
		// execution is serialized, so this is atomic within the RPC.
		const current = this.getInvocationLedgerRowById(input.invocationId)
		const released =
			current != null &&
			current.status === 'in_progress' &&
			current.updatedAt === input.claimUpdatedAt
		if (released) {
			this.ctx.storage.sql.exec(
				`DELETE FROM package_invocation_ledger WHERE id = ?`,
				input.invocationId,
			)
		}
		if (input.runId) {
			await this.deleteRunIfRunning({ runId: input.runId })
		}
		if (released) {
			return { released: true, record: null }
		}
		return { released: false, record: current }
	}

	/**
	 * Authoritative workflow projection write: monotonic by `updated_at`, plus
	 * terminal-stickiness (terminal statuses are not overwritten by stale
	 * active/running updates).
	 */
	private writeWorkflowProjectionRow(input: WorkflowProjectionUpsertInput) {
		const now = new Date().toISOString()
		const createdAt = input.createdAt?.trim() || now
		const updatedAt = input.updatedAt?.trim() || now
		const terminalPlaceholders = workflowProjectionTerminalStatuses
			.map(() => '?')
			.join(', ')
		this.ctx.storage.sql.exec(
			`INSERT INTO workflow_projections (
				id, binding_name, source_type, package_id, kody_id, source_id,
				workflow_name, export_name, idempotency_key, run_at, plan_date,
				status, created_at, updated_at, completed_at, last_error
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				status = excluded.status,
				updated_at = excluded.updated_at,
				completed_at = COALESCE(excluded.completed_at, workflow_projections.completed_at),
				last_error = COALESCE(excluded.last_error, workflow_projections.last_error)
			WHERE excluded.updated_at >= workflow_projections.updated_at
				AND (
					COALESCE(workflow_projections.status, '') NOT IN (${terminalPlaceholders})
					OR COALESCE(excluded.status, '') IN (${terminalPlaceholders})
				)`,
			input.id,
			input.bindingName,
			input.sourceType,
			input.packageId ?? null,
			input.kodyId ?? null,
			input.sourceId ?? null,
			input.workflowName,
			input.exportName ?? null,
			input.idempotencyKey,
			input.runAt,
			input.planDate ?? null,
			input.status ?? null,
			createdAt,
			updatedAt,
			input.completedAt ?? null,
			input.lastError ?? null,
			...workflowProjectionTerminalStatuses,
			...workflowProjectionTerminalStatuses,
		)
	}

	async upsertWorkflowProjection(
		input: WorkflowProjectionUpsertInput,
	): Promise<{ ok: true }> {
		this.writeWorkflowProjectionRow(input)
		// Terminal projections create future age-prune work.
		this.retentionIdleConfirmed = false
		await this.ensureRetentionAlarm()
		return { ok: true }
	}

	async getWorkflowProjection(input: {
		id: string
	}): Promise<WorkflowProjectionRecord | null> {
		const row = this.ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM workflow_projections WHERE id = ? LIMIT 1`,
				input.id,
			)
			.toArray()[0]
		return row ? mapWorkflowProjectionRow(row) : null
	}

	async findWorkflowProjectionByIdempotencyKey(input: {
		idempotencyKey: string
		bindingName?: string | null
	}): Promise<WorkflowProjectionRecord | null> {
		const trimmedKey = input.idempotencyKey.trim()
		if (!trimmedKey) return null
		const bindingName = input.bindingName?.trim() || null
		const row = bindingName
			? this.ctx.storage.sql
					.exec<Record<string, SqlStorageValue>>(
						`SELECT *
						FROM workflow_projections
						WHERE idempotency_key = ?
							AND binding_name = ?
							AND COALESCE(status, '') != ?
						ORDER BY created_at ASC
						LIMIT 1`,
						trimmedKey,
						bindingName,
						creatingWorkflowProjectionStatus,
					)
					.toArray()[0]
			: this.ctx.storage.sql
					.exec<Record<string, SqlStorageValue>>(
						`SELECT *
						FROM workflow_projections
						WHERE idempotency_key = ?
							AND COALESCE(status, '') != ?
						ORDER BY created_at ASC
						LIMIT 1`,
						trimmedKey,
						creatingWorkflowProjectionStatus,
					)
					.toArray()[0]
		return row ? mapWorkflowProjectionRow(row) : null
	}

	/**
	 * Exact binding + idempotency lookup that includes `creating` rows. Prefer
	 * this over listing/scanning creating projections.
	 */
	async findWorkflowProjectionByBindingIdempotencyKey(input: {
		bindingName: string
		idempotencyKey: string
	}): Promise<WorkflowProjectionRecord | null> {
		const bindingName = input.bindingName.trim()
		const trimmedKey = input.idempotencyKey.trim()
		if (!bindingName || !trimmedKey) return null
		const row = this.ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT *
				FROM workflow_projections
				WHERE binding_name = ?
					AND idempotency_key = ?
				ORDER BY created_at ASC
				LIMIT 1`,
				bindingName,
				trimmedKey,
			)
			.toArray()[0]
		return row ? mapWorkflowProjectionRow(row) : null
	}

	async listWorkflowProjections(input: WorkflowProjectionListInput): Promise<{
		projections: Array<WorkflowProjectionRecord>
		nextCursor: string | null
	}> {
		const limit = normalizePageSize(input.limit, runRecordDefaultPageSize)
		const clauses: Array<string> = ['1 = 1']
		const params: Array<SqlStorageValue> = []
		if (input.status) {
			clauses.push('status = ?')
			params.push(input.status)
		}
		const bindingName = input.bindingName?.trim() || null
		if (bindingName) {
			clauses.push('binding_name = ?')
			params.push(bindingName)
		}
		if (input.cursor) {
			const cursor = decodeCursor(input.cursor)
			if (cursor) {
				clauses.push('(created_at, id) < (?, ?)')
				params.push(cursor.startedAt, cursor.id)
			}
		}
		params.push(limit + 1)
		const rows = this.ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM workflow_projections
				WHERE ${clauses.join(' AND ')}
				ORDER BY created_at DESC, id DESC
				LIMIT ?`,
				...params,
			)
			.toArray()
		const hasMore = rows.length > limit
		const pageRows = hasMore ? rows.slice(0, limit) : rows
		const projections = pageRows.map(mapWorkflowProjectionRow)
		const last = pageRows[pageRows.length - 1]
		const nextCursor =
			hasMore && last
				? encodeCursor({
						startedAt: String(last['created_at']),
						id: String(last['id']),
					})
				: null
		return { projections, nextCursor }
	}

	async countActiveWorkflowProjections(): Promise<{ count: number }> {
		const placeholders = workflowProjectionActiveStatuses
			.map(() => '?')
			.join(', ')
		const row = this.ctx.storage.sql
			.exec<{ count: number }>(
				`SELECT COUNT(*) AS count FROM workflow_projections
				WHERE status IN (${placeholders})`,
				...workflowProjectionActiveStatuses,
			)
			.one()
		return { count: Number(row.count ?? 0) || 0 }
	}

	/**
	 * Atomically prune stale creating rows, count entitlement-occupying
	 * projections (active + creating, excluding this id), and insert-only
	 * claim a `creating` reservation. Never overwrites queued/running/terminal
	 * state. Returns the count *before* this reservation for
	 * assertWithinEntitlement getCurrent.
	 */
	async reserveWorkflowProjectionSlot(
		input: WorkflowProjectionUpsertInput,
	): Promise<WorkflowProjectionReserveResult> {
		const now = new Date().toISOString()
		this.pruneStaleCreatingWorkflowProjections()

		const existing = this.ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM workflow_projections WHERE id = ? LIMIT 1`,
				input.id,
			)
			.toArray()[0]
		const existingStatus =
			existing && typeof existing['status'] === 'string'
				? String(existing['status'])
				: null

		const reservationPlaceholders = workflowProjectionReservationStatuses
			.map(() => '?')
			.join(', ')
		const countRow = this.ctx.storage.sql
			.exec<{ count: number }>(
				`SELECT COUNT(*) AS count FROM workflow_projections
				WHERE status IN (${reservationPlaceholders})
					AND id != ?`,
				...workflowProjectionReservationStatuses,
				input.id,
			)
			.one()
		const countBeforeReservation = Number(countRow.count ?? 0) || 0

		// Insert-only / creating-refresh: never clobber queued/running/terminal.
		if (
			existing != null &&
			existingStatus != null &&
			existingStatus !== creatingWorkflowProjectionStatus
		) {
			return {
				countBeforeReservation,
				reserved: false,
				inserted: false,
				projection: mapWorkflowProjectionRow(existing),
			}
		}

		const createdAt =
			input.createdAt?.trim() ||
			(existing ? String(existing['created_at']) : now)
		const updatedAt = input.updatedAt?.trim() || now
		const inserted = existing == null
		this.ctx.storage.sql.exec(
			`INSERT INTO workflow_projections (
				id, binding_name, source_type, package_id, kody_id, source_id,
				workflow_name, export_name, idempotency_key, run_at, plan_date,
				status, created_at, updated_at, completed_at, last_error
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
			ON CONFLICT(id) DO UPDATE SET
				updated_at = excluded.updated_at
			WHERE COALESCE(workflow_projections.status, '') = ?`,
			input.id,
			input.bindingName,
			input.sourceType,
			input.packageId ?? null,
			input.kodyId ?? null,
			input.sourceId ?? null,
			input.workflowName,
			input.exportName ?? null,
			input.idempotencyKey,
			input.runAt,
			input.planDate ?? null,
			creatingWorkflowProjectionStatus,
			createdAt,
			updatedAt,
			creatingWorkflowProjectionStatus,
		)
		// Re-read: ON CONFLICT may no-op when status is not `creating` (e.g.
		// null), and for existing creating rows only `updated_at` changes —
		// so the persisted row is the source of truth, not `input`.
		const projection = await this.getWorkflowProjection({ id: input.id })
		if (!projection) {
			throw new Error(
				`Workflow projection "${input.id}" disappeared after reservation.`,
			)
		}
		this.retentionIdleConfirmed = false
		await this.ensureRetentionAlarm()
		return {
			countBeforeReservation,
			reserved: projection.status === creatingWorkflowProjectionStatus,
			inserted,
			projection,
		}
	}

	async deleteWorkflowProjectionIfCreating(input: {
		id: string
	}): Promise<{ deleted: boolean }> {
		const deleted = this.ctx.storage.sql.exec(
			`DELETE FROM workflow_projections
			WHERE id = ? AND COALESCE(status, '') = ?`,
			input.id,
			creatingWorkflowProjectionStatus,
		).rowsWritten
		return { deleted: deleted > 0 }
	}

	async upsertJobRunObservability(
		input: JobRunObservabilityUpsertInput,
	): Promise<JobRunObservabilityRecord> {
		return this.writeJobRunObservabilityOutcome(input)
	}

	/**
	 * Content-free admin-insights point-read. Workflow statuses, job outcome
	 * counts, and activation milestone timestamps/ids needed for aggregate
	 * reporting — never names, errors, logs, or user content.
	 */
	async getAdminInsightsSnapshot(): Promise<RunLogAdminInsightsSnapshot> {
		const workflowRows = this.ctx.storage.sql
			.exec<{ status: string; n: number }>(
				`SELECT COALESCE(NULLIF(TRIM(status), ''), 'unknown') AS status,
					COUNT(*) AS n
				FROM workflow_projections
				GROUP BY COALESCE(NULLIF(TRIM(status), ''), 'unknown')
				ORDER BY n DESC, status ASC`,
			)
			.toArray()
		const milestones = this.ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM activation_milestones ORDER BY milestone ASC`,
			)
			.toArray()
			.map(mapActivationMilestoneRow)
		const jobRunCounts = this.ctx.storage.sql
			.exec<{ error: number; success: number }>(
				`SELECT
					COALESCE(SUM(success_count), 0) AS success,
					COALESCE(SUM(error_count), 0) AS error
				FROM job_run_observability`,
			)
			.one()
		return {
			workflowStatusCounts: workflowRows.map((row) => ({
				status: String(row.status),
				count: Number(row.n) || 0,
			})),
			activationMilestones: milestones.map((row) => ({
				milestone: row.milestone,
				reachedAt: row.reachedAt,
				packageId: row.packageId,
			})),
			jobRunCounts: {
				success: Number(jobRunCounts.success) || 0,
				error: Number(jobRunCounts.error) || 0,
			},
		}
	}

	private getJobRunObservabilitySync(
		jobId: string,
	): JobRunObservabilityRecord | null {
		const row = this.ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM job_run_observability WHERE job_id = ? LIMIT 1`,
				jobId,
			)
			.toArray()[0]
		return row ? mapJobRunObservabilityRow(row) : null
	}

	async getJobRunObservability(input: {
		jobId: string
	}): Promise<JobRunObservabilityRecord | null> {
		return this.getJobRunObservabilitySync(input.jobId)
	}

	async getJobRunObservabilityBatch(input: {
		jobIds: Array<string>
	}): Promise<Array<JobRunObservabilityRecord>> {
		const ids = [
			...new Set(
				input.jobIds.map((id) => id.trim()).filter((id) => id.length > 0),
			),
		]
		if (ids.length === 0) return []
		const placeholders = ids.map(() => '?').join(', ')
		return this.ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM job_run_observability
				WHERE job_id IN (${placeholders})
				ORDER BY job_id ASC`,
				...ids,
			)
			.toArray()
			.map(mapJobRunObservabilityRow)
	}

	async listPackageRunSuccesses(): Promise<Array<PackageRunSuccessRecord>> {
		return this.ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM package_run_successes ORDER BY package_id ASC`,
			)
			.toArray()
			.map(mapPackageRunSuccessRow)
	}

	async listActivationMilestones(): Promise<Array<ActivationMilestoneRecord>> {
		return this.ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM activation_milestones ORDER BY milestone ASC`,
			)
			.toArray()
			.map(mapActivationMilestoneRow)
	}

	async listRuns(input: ListRunsInput): Promise<RunRecordPage> {
		// Heal before listing so `status=running` filters and Activity views
		// do not keep advertising stranded rows past their surface TTL.
		this.reconcileStaleRunning()
		const limit = normalizePageSize(input.limit, runRecordDefaultPageSize)
		const clauses: Array<string> = ['1 = 1']
		const params: Array<SqlStorageValue> = []
		if (input.surface) {
			clauses.push('r.surface = ?')
			params.push(input.surface)
		}
		if (input.status) {
			clauses.push('r.status = ?')
			params.push(input.status)
		}
		if (input.packageId) {
			clauses.push('r.package_id = ?')
			params.push(input.packageId)
		}
		if (input.jobId) {
			clauses.push('r.job_id = ?')
			params.push(input.jobId)
		}
		if (input.name) {
			clauses.push('r.name = ?')
			params.push(input.name)
		}
		if (input.since) {
			clauses.push('r.started_at >= ?')
			params.push(input.since)
		}
		const errorTriage = input.errorTriage ?? null
		if (errorTriage === 'open') {
			// Hide ignored/resolved noise; successes and running rows have NULL
			// triage and remain visible.
			clauses.push('r.error_triage IS NULL')
		} else if (errorTriage === 'ignored') {
			clauses.push(`r.error_triage = 'ignored'`)
		} else if (errorTriage === 'resolved') {
			clauses.push(`r.error_triage = 'resolved'`)
		} else if (errorTriage === 'all' || errorTriage == null) {
			// No triage filter.
		} else {
			const exhaustive: never = errorTriage
			throw new Error(`Unhandled error triage filter: ${String(exhaustive)}`)
		}
		if (input.cursor) {
			const cursor = decodeCursor(input.cursor)
			if (cursor) {
				clauses.push('(r.started_at, r.id) < (?, ?)')
				params.push(cursor.startedAt, cursor.id)
			}
		}
		params.push(limit + 1)
		const rows = this.ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT r.*,
					(SELECT COUNT(*) FROM run_logs l WHERE l.run_id = r.id) AS log_count
				FROM runs r
				WHERE ${clauses.join(' AND ')}
				ORDER BY r.started_at DESC, r.id DESC
				LIMIT ?`,
				...params,
			)
			.toArray()
		const hasMore = rows.length > limit
		const pageRows = hasMore ? rows.slice(0, limit) : rows
		const runs = pageRows.map((row) =>
			mapRunRow(row, Number(row['log_count'] ?? 0) || 0),
		)
		const last = pageRows[pageRows.length - 1]
		const nextCursor =
			hasMore && last
				? encodeCursor({
						startedAt: String(last['started_at']),
						id: String(last['id']),
					})
				: null
		return { runs, nextCursor }
	}

	async getRun(input: {
		runId: string
	}): Promise<{ run: RunRecord; logs: Array<RunRecordLog> } | null> {
		const row = this.ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT r.*,
					(SELECT COUNT(*) FROM run_logs l WHERE l.run_id = r.id) AS log_count
				FROM runs r
				WHERE r.id = ?
				LIMIT 1`,
				input.runId,
			)
			.toArray()[0]
		if (!row) return null
		const run = this.healStaleRunningRecord(
			mapRunRow(row, Number(row['log_count'] ?? 0) || 0),
		)
		const logs = this.ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM run_logs WHERE run_id = ? ORDER BY sequence ASC`,
				input.runId,
			)
			.toArray()
			.map(mapLogRow)
		return {
			run,
			logs,
		}
	}

	async summarize(input: { since: string }): Promise<RunRecordSummary> {
		this.reconcileStaleRunning()
		const since = input.since
		const totals = this.ctx.storage.sql
			.exec<{
				total: number
				errors: number
				ignored: number
				resolved: number
				running: number
			}>(
				`SELECT
					COUNT(*) AS total,
					SUM(CASE
						WHEN status = 'error' AND error_triage IS NULL THEN 1
						ELSE 0
					END) AS errors,
					SUM(CASE WHEN error_triage = 'ignored' THEN 1 ELSE 0 END) AS ignored,
					SUM(CASE WHEN error_triage = 'resolved' THEN 1 ELSE 0 END) AS resolved,
					SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running
				FROM runs
				WHERE started_at >= ?`,
				since,
			)
			.one()
		const bySurfaceRows = this.ctx.storage.sql
			.exec<{ surface: string; total: number; errors: number }>(
				`SELECT
					surface,
					COUNT(*) AS total,
					SUM(CASE
						WHEN status = 'error' AND error_triage IS NULL THEN 1
						ELSE 0
					END) AS errors
				FROM runs
				WHERE started_at >= ?
				GROUP BY surface
				ORDER BY surface ASC`,
				since,
			)
			.toArray()
		return {
			since,
			total: Number(totals.total ?? 0) || 0,
			errors: Number(totals.errors ?? 0) || 0,
			ignored: Number(totals.ignored ?? 0) || 0,
			resolved: Number(totals.resolved ?? 0) || 0,
			running: Number(totals.running ?? 0) || 0,
			bySurface: bySurfaceRows.map((row) => ({
				surface: (isRunSurface(row.surface)
					? row.surface
					: 'execute') as RunSurface,
				total: Number(row.total ?? 0) || 0,
				errors: Number(row.errors ?? 0) || 0,
			})),
		}
	}

	/**
	 * Soft-triage a retained error run. Does not delete or rewrite error
	 * details. Only `status = 'error'` rows accept ignored/resolved; reopen
	 * (`errorTriage: null`) clears triage on any retained row that has it.
	 * Returns a result object instead of throwing so RPC callers can map
	 * caller errors without uncaught DO promise rejections.
	 */
	async updateRunErrorTriage(
		input: UpdateRunErrorTriageInput,
	): Promise<UpdateRunErrorTriageResult> {
		const existing = this.ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT r.*,
					(SELECT COUNT(*) FROM run_logs l WHERE l.run_id = r.id) AS log_count
				FROM runs r
				WHERE r.id = ?
				LIMIT 1`,
				input.runId,
			)
			.toArray()[0]
		if (!existing) return { ok: false, reason: 'not_found' }

		const current = mapRunRow(existing, Number(existing['log_count'] ?? 0) || 0)
		const nextTriage = input.errorTriage
		if (nextTriage != null && current.status !== 'error') {
			return {
				ok: false,
				reason: 'not_error',
				status: current.status,
				runId: input.runId,
			}
		}

		const now = new Date().toISOString()
		let triageNote: string | null
		let triagedAt: string | null
		let triagedBy: string | null
		if (nextTriage == null) {
			triageNote = null
			triagedAt = null
			triagedBy = null
		} else {
			if (input.preserveTriageNote) {
				triageNote = current.triageNote
			} else if (input.triageNote == null) {
				triageNote = null
			} else {
				const trimmed = input.triageNote.trim()
				triageNote =
					trimmed.length === 0
						? null
						: trimmed.slice(0, runErrorTriageMaxNoteLength)
			}
			triagedAt = now
			triagedBy = input.triagedBy.trim() || null
		}

		this.ctx.storage.sql.exec(
			`UPDATE runs
			SET error_triage = ?,
				triage_note = ?,
				triaged_at = ?,
				triaged_by = ?,
				updated_at = ?
			WHERE id = ?`,
			nextTriage,
			triageNote,
			triagedAt,
			triagedBy,
			now,
			input.runId,
		)

		const updated = this.ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT r.*,
					(SELECT COUNT(*) FROM run_logs l WHERE l.run_id = r.id) AS log_count
				FROM runs r
				WHERE r.id = ?
				LIMIT 1`,
				input.runId,
			)
			.toArray()[0]
		if (!updated) return { ok: false, reason: 'not_found' }
		return {
			ok: true,
			run: mapRunRow(updated, Number(updated['log_count'] ?? 0) || 0),
		}
	}

	/**
	 * Bounded soft triage for explicit run ids or an exact-match filter. The
	 * caller validates that one selector is present; this layer still forces
	 * status=error so successes can never be triaged accidentally.
	 */
	async bulkUpdateRunErrorTriage(
		input: BulkUpdateRunErrorTriageInput,
	): Promise<BulkUpdateRunErrorTriageResult> {
		const limit = normalizePageSize(input.limit, runRecordMaxPageSize)
		const clauses = [`status = 'error'`]
		const params: Array<SqlStorageValue> = []
		// Reopening already-open rows is a no-op and must not inflate matched or
		// updated counts, regardless of selector type.
		if (input.errorTriage == null) {
			clauses.push('error_triage IS NOT NULL')
		}
		const runIds = (input.runIds ?? [])
			.map((id) => id.trim())
			.filter(Boolean)
			.slice(0, runRecordMaxPageSize)
		if (runIds.length > 0) {
			clauses.push(`id IN (${runIds.map(() => '?').join(', ')})`)
			params.push(...runIds)
		} else {
			const filter = input.filter
			if (!filter) {
				return { matchedRunIds: [], updatedCount: 0, hasMore: false }
			}
			if (filter.surface) {
				clauses.push('surface = ?')
				params.push(filter.surface)
			}
			if (filter.packageId) {
				clauses.push('package_id = ?')
				params.push(filter.packageId)
			}
			if (filter.jobId) {
				clauses.push('job_id = ?')
				params.push(filter.jobId)
			}
			if (filter.name) {
				clauses.push('name = ?')
				params.push(filter.name)
			}
			if (filter.errorName) {
				clauses.push('error_name = ?')
				params.push(filter.errorName)
			}
			if (filter.errorMessage) {
				clauses.push('error_message = ?')
				params.push(filter.errorMessage)
			}
			const filterTriage =
				filter.errorTriage ??
				(input.errorTriage == null ? null : ('open' as const))
			if (filterTriage === 'open') {
				clauses.push('error_triage IS NULL')
			} else if (filterTriage === 'ignored') {
				clauses.push(`error_triage = 'ignored'`)
			} else if (filterTriage === 'resolved') {
				clauses.push(`error_triage = 'resolved'`)
			} else if (filterTriage === 'all' || filterTriage == null) {
				// No triage filter.
			} else {
				const exhaustive: never = filterTriage
				throw new Error(
					`Unhandled bulk error triage filter: ${String(exhaustive)}`,
				)
			}
		}

		const rows = this.ctx.storage.sql
			.exec<{ id: string }>(
				`SELECT id FROM runs
				WHERE ${clauses.join(' AND ')}
				ORDER BY started_at DESC, id DESC
				LIMIT ${limit + 1}`,
				...params,
			)
			.toArray()
		const hasMore = rows.length > limit
		const matchedRunIds = rows.slice(0, limit).map((row) => row.id)
		if (input.dryRun || matchedRunIds.length === 0) {
			return { matchedRunIds, updatedCount: 0, hasMore }
		}

		const now = new Date().toISOString()
		this.ctx.storage.transactionSync(() => {
			if (input.errorTriage == null) {
				for (const runIdChunk of chunkArray(
					matchedRunIds,
					maxD1BoundParameters - 1,
				)) {
					const placeholders = runIdChunk.map(() => '?').join(', ')
					this.ctx.storage.sql.exec(
						`UPDATE runs
						SET error_triage = NULL,
							triage_note = NULL,
							triaged_at = NULL,
							triaged_by = NULL,
							updated_at = ?
						WHERE id IN (${placeholders}) AND status = 'error'`,
						now,
						...runIdChunk,
					)
				}
			} else {
				const triageNote =
					input.triageNote == null
						? null
						: input.triageNote.trim().slice(0, runErrorTriageMaxNoteLength) ||
							null
				for (const runIdChunk of chunkArray(
					matchedRunIds,
					maxD1BoundParameters - 6,
				)) {
					const placeholders = runIdChunk.map(() => '?').join(', ')
					this.ctx.storage.sql.exec(
						`UPDATE runs
						SET error_triage = ?,
							triage_note = CASE WHEN ? = 1 THEN triage_note ELSE ? END,
							triaged_at = ?,
							triaged_by = ?,
							updated_at = ?
						WHERE id IN (${placeholders}) AND status = 'error'`,
						input.errorTriage,
						input.preserveTriageNote ? 1 : 0,
						triageNote,
						now,
						input.triagedBy.trim() || null,
						now,
						...runIdChunk,
					)
				}
			}
		})
		return {
			matchedRunIds,
			updatedCount: matchedRunIds.length,
			hasMore,
		}
	}

	async listStorageIds(): Promise<Array<string>> {
		return this.ctx.storage.sql
			.exec<{ storage_id: string }>(
				`SELECT DISTINCT storage_id AS storage_id
				FROM runs
				WHERE storage_id IS NOT NULL
				ORDER BY storage_id ASC`,
			)
			.toArray()
			.map((row) => row.storage_id)
	}

	/**
	 * Paged export across dedicated DO state in fixed phases:
	 * 1. runs (raw run-id cursors — compatible with pre-ledger exports)
	 * 2. invocation-ledger (`invocation-ledger:`)
	 * 3. workflow-projections (`workflow-projections:`)
	 * 4. job-run-observability (`job-run-observability:`)
	 * 5. package-run-successes (`package-run-successes:`)
	 * 6. activation-milestones (`activation-milestones:`)
	 *
	 * Each phase fills the remainder of the page into the next so exports stay
	 * one-cursor. Old run-id and ledger cursors remain valid.
	 */
	async exportRuns(input: ExportRunsInput): Promise<ExportRunsResult> {
		const pageSize = normalizePageSize(input.pageSize, runRecordDefaultPageSize)
		const startAfterRaw = input.startAfter?.trim() || null
		const empty: ExportRunsResult = {
			runs: [],
			logs: [],
			packageInvocations: [],
			workflowProjections: [],
			jobRunObservability: [],
			packageRunSuccesses: [],
			activationMilestones: [],
			nextStartAfter: null,
			truncated: false,
		}

		type ExportPhase =
			| 'runs'
			| 'invocation-ledger'
			| 'workflow-projections'
			| 'job-run-observability'
			| 'package-run-successes'
			| 'activation-milestones'

		const phaseOrder: Array<ExportPhase> = [
			'runs',
			'invocation-ledger',
			'workflow-projections',
			'job-run-observability',
			'package-run-successes',
			'activation-milestones',
		]

		const parsePhase = (
			cursor: string | null,
		): { phase: ExportPhase; startAfterId: string } => {
			if (!cursor) return { phase: 'runs', startAfterId: '' }
			if (cursor.startsWith(exportLedgerCursorPrefix)) {
				return {
					phase: 'invocation-ledger',
					startAfterId: cursor.slice(exportLedgerCursorPrefix.length),
				}
			}
			if (cursor.startsWith(exportWorkflowProjectionsCursorPrefix)) {
				return {
					phase: 'workflow-projections',
					startAfterId: cursor.slice(
						exportWorkflowProjectionsCursorPrefix.length,
					),
				}
			}
			if (cursor.startsWith(exportJobRunObservabilityCursorPrefix)) {
				return {
					phase: 'job-run-observability',
					startAfterId: cursor.slice(
						exportJobRunObservabilityCursorPrefix.length,
					),
				}
			}
			if (cursor.startsWith(exportPackageRunSuccessesCursorPrefix)) {
				return {
					phase: 'package-run-successes',
					startAfterId: cursor.slice(
						exportPackageRunSuccessesCursorPrefix.length,
					),
				}
			}
			if (cursor.startsWith(exportActivationMilestonesCursorPrefix)) {
				return {
					phase: 'activation-milestones',
					startAfterId: cursor.slice(
						exportActivationMilestonesCursorPrefix.length,
					),
				}
			}
			return { phase: 'runs', startAfterId: cursor }
		}

		const cursorPrefixForPhase = (phase: ExportPhase): string | null => {
			switch (phase) {
				case 'runs':
					return null
				case 'invocation-ledger':
					return exportLedgerCursorPrefix
				case 'workflow-projections':
					return exportWorkflowProjectionsCursorPrefix
				case 'job-run-observability':
					return exportJobRunObservabilityCursorPrefix
				case 'package-run-successes':
					return exportPackageRunSuccessesCursorPrefix
				case 'activation-milestones':
					return exportActivationMilestonesCursorPrefix
				default: {
					const exhaustive: never = phase
					throw new Error(`Unhandled export phase: ${String(exhaustive)}`)
				}
			}
		}

		const result: ExportRunsResult = { ...empty }
		let { phase, startAfterId } = parsePhase(startAfterRaw)
		let remaining = pageSize
		let phaseIndex = phaseOrder.indexOf(phase)
		// Hard cap: each iteration either emits rows, advances phase, or
		// returns. Bound by phase count so a stuck cursor cannot spin.
		const maxIterations = phaseOrder.length + 1
		let iterations = 0

		while (phaseIndex < phaseOrder.length) {
			iterations += 1
			if (iterations > maxIterations) {
				throw new Error('exportRuns exceeded phase iteration budget')
			}
			// Never query a phase with a zero limit — that used to return
			// truncated:true with the same cursor and could infinite-loop
			// clients that retry while truncated.
			if (remaining <= 0) {
				const nextPhase = phaseOrder[phaseIndex]!
				const prefix = cursorPrefixForPhase(nextPhase)
				const handoff = prefix ? `${prefix}` : null
				if (handoff != null && handoff === startAfterRaw) {
					phaseIndex += 1
					startAfterId = ''
					continue
				}
				result.nextStartAfter = handoff
				result.truncated = handoff != null
				return result
			}

			const currentPhase = phaseOrder[phaseIndex]!
			const page = this.exportPhasePage({
				phase: currentPhase,
				startAfterId,
				limit: remaining,
			})
			switch (currentPhase) {
				case 'runs': {
					result.runs.push(...page.runs)
					result.logs.push(...page.logs)
					break
				}
				case 'invocation-ledger': {
					result.packageInvocations.push(...page.packageInvocations)
					break
				}
				case 'workflow-projections': {
					result.workflowProjections.push(...page.workflowProjections)
					break
				}
				case 'job-run-observability': {
					result.jobRunObservability.push(...page.jobRunObservability)
					break
				}
				case 'package-run-successes': {
					result.packageRunSuccesses.push(...page.packageRunSuccesses)
					break
				}
				case 'activation-milestones': {
					result.activationMilestones.push(...page.activationMilestones)
					break
				}
				default: {
					const exhaustive: never = currentPhase
					throw new Error(`Unhandled export phase: ${String(exhaustive)}`)
				}
			}
			remaining -= page.taken

			if (page.truncated) {
				// Zero-row "truncation" cannot make progress; treat as exhausted.
				if (page.taken <= 0) {
					phaseIndex += 1
					startAfterId = ''
					continue
				}
				const prefix = cursorPrefixForPhase(currentPhase)
				const nextStartAfter = prefix ? `${prefix}${page.nextId}` : page.nextId
				// Refuse to emit the inbound cursor again (would spin clients).
				if (nextStartAfter === startAfterRaw) {
					phaseIndex += 1
					startAfterId = ''
					continue
				}
				result.nextStartAfter = nextStartAfter
				result.truncated = true
				return result
			}

			// Phase exhausted. If the page budget is spent, hand off to the
			// next phase prefix so the following call starts there (legacy
			// ledger handoff contract).
			phaseIndex += 1
			startAfterId = ''
			if (remaining <= 0 && phaseIndex < phaseOrder.length) {
				const nextPhase = phaseOrder[phaseIndex]!
				const prefix = cursorPrefixForPhase(nextPhase)
				const handoff = prefix ? `${prefix}` : null
				if (handoff != null && handoff === startAfterRaw) {
					continue
				}
				result.nextStartAfter = handoff
				result.truncated = handoff != null
				return result
			}
		}
		return result
	}

	private exportPhasePage(input: {
		phase:
			| 'runs'
			| 'invocation-ledger'
			| 'workflow-projections'
			| 'job-run-observability'
			| 'package-run-successes'
			| 'activation-milestones'
		startAfterId: string
		limit: number
	}): {
		runs: Array<RunRecord>
		logs: Array<RunRecordLog>
		packageInvocations: Array<PackageInvocationLedgerRecord>
		workflowProjections: Array<WorkflowProjectionRecord>
		jobRunObservability: Array<JobRunObservabilityRecord>
		packageRunSuccesses: Array<PackageRunSuccessRecord>
		activationMilestones: Array<ActivationMilestoneRecord>
		taken: number
		truncated: boolean
		nextId: string
	} {
		const empty = {
			runs: [] as Array<RunRecord>,
			logs: [] as Array<RunRecordLog>,
			packageInvocations: [] as Array<PackageInvocationLedgerRecord>,
			workflowProjections: [] as Array<WorkflowProjectionRecord>,
			jobRunObservability: [] as Array<JobRunObservabilityRecord>,
			packageRunSuccesses: [] as Array<PackageRunSuccessRecord>,
			activationMilestones: [] as Array<ActivationMilestoneRecord>,
			taken: 0,
			truncated: false,
			nextId: input.startAfterId,
		}
		// Callers must not request a zero-limit page; treat as exhausted so
		// the export loop advances instead of re-emitting the same cursor.
		if (input.limit <= 0) {
			return empty
		}
		const limit = Math.trunc(input.limit)

		switch (input.phase) {
			case 'runs': {
				const rows = (
					input.startAfterId
						? this.ctx.storage.sql.exec<Record<string, SqlStorageValue>>(
								`SELECT r.*,
									(SELECT COUNT(*) FROM run_logs l WHERE l.run_id = r.id) AS log_count
								FROM runs r
								WHERE r.id > ?
								ORDER BY r.id ASC
								LIMIT ?`,
								input.startAfterId,
								limit + 1,
							)
						: this.ctx.storage.sql.exec<Record<string, SqlStorageValue>>(
								`SELECT r.*,
									(SELECT COUNT(*) FROM run_logs l WHERE l.run_id = r.id) AS log_count
								FROM runs r
								ORDER BY r.id ASC
								LIMIT ?`,
								limit + 1,
							)
				).toArray()
				const truncated = rows.length > limit
				const pageRows = truncated ? rows.slice(0, limit) : rows
				const runs = pageRows.map((row) =>
					mapRunRow(row, Number(row['log_count'] ?? 0) || 0),
				)
				const logs: Array<RunRecordLog> = []
				for (const run of runs) {
					const runLogs = this.ctx.storage.sql
						.exec<Record<string, SqlStorageValue>>(
							`SELECT * FROM run_logs WHERE run_id = ? ORDER BY sequence ASC`,
							run.id,
						)
						.toArray()
						.map(mapLogRow)
					logs.push(...runLogs)
				}
				const last = pageRows[pageRows.length - 1]
				return {
					...empty,
					runs,
					logs,
					taken: runs.length,
					truncated,
					nextId: last ? String(last['id']) : input.startAfterId,
				}
			}
			case 'invocation-ledger': {
				const rows = this.ctx.storage.sql
					.exec<Record<string, SqlStorageValue>>(
						`SELECT * FROM package_invocation_ledger
						WHERE id > ?
						ORDER BY id ASC
						LIMIT ?`,
						input.startAfterId,
						limit + 1,
					)
					.toArray()
				const truncated = rows.length > limit
				const pageRows = truncated ? rows.slice(0, limit) : rows
				const last = pageRows[pageRows.length - 1]
				return {
					...empty,
					packageInvocations: pageRows.map(mapInvocationLedgerRow),
					taken: pageRows.length,
					truncated,
					nextId: last ? String(last['id']) : input.startAfterId,
				}
			}
			case 'workflow-projections': {
				const rows = this.ctx.storage.sql
					.exec<Record<string, SqlStorageValue>>(
						`SELECT * FROM workflow_projections
						WHERE id > ?
						ORDER BY id ASC
						LIMIT ?`,
						input.startAfterId,
						limit + 1,
					)
					.toArray()
				const truncated = rows.length > limit
				const pageRows = truncated ? rows.slice(0, limit) : rows
				const last = pageRows[pageRows.length - 1]
				return {
					...empty,
					workflowProjections: pageRows.map(mapWorkflowProjectionRow),
					taken: pageRows.length,
					truncated,
					nextId: last ? String(last['id']) : input.startAfterId,
				}
			}
			case 'job-run-observability': {
				const rows = this.ctx.storage.sql
					.exec<Record<string, SqlStorageValue>>(
						`SELECT * FROM job_run_observability
						WHERE job_id > ?
						ORDER BY job_id ASC
						LIMIT ?`,
						input.startAfterId,
						limit + 1,
					)
					.toArray()
				const truncated = rows.length > limit
				const pageRows = truncated ? rows.slice(0, limit) : rows
				const last = pageRows[pageRows.length - 1]
				return {
					...empty,
					jobRunObservability: pageRows.map(mapJobRunObservabilityRow),
					taken: pageRows.length,
					truncated,
					nextId: last ? String(last['job_id']) : input.startAfterId,
				}
			}
			case 'package-run-successes': {
				const rows = this.ctx.storage.sql
					.exec<Record<string, SqlStorageValue>>(
						`SELECT * FROM package_run_successes
						WHERE package_id > ?
						ORDER BY package_id ASC
						LIMIT ?`,
						input.startAfterId,
						limit + 1,
					)
					.toArray()
				const truncated = rows.length > limit
				const pageRows = truncated ? rows.slice(0, limit) : rows
				const last = pageRows[pageRows.length - 1]
				return {
					...empty,
					packageRunSuccesses: pageRows.map(mapPackageRunSuccessRow),
					taken: pageRows.length,
					truncated,
					nextId: last ? String(last['package_id']) : input.startAfterId,
				}
			}
			case 'activation-milestones': {
				const rows = this.ctx.storage.sql
					.exec<Record<string, SqlStorageValue>>(
						`SELECT * FROM activation_milestones
						WHERE milestone > ?
						ORDER BY milestone ASC
						LIMIT ?`,
						input.startAfterId,
						limit + 1,
					)
					.toArray()
				const truncated = rows.length > limit
				const pageRows = truncated ? rows.slice(0, limit) : rows
				const last = pageRows[pageRows.length - 1]
				return {
					...empty,
					activationMilestones: pageRows.map(mapActivationMilestoneRow),
					taken: pageRows.length,
					truncated,
					nextId: last ? String(last['milestone']) : input.startAfterId,
				}
			}
			default: {
				const exhaustive: never = input.phase
				throw new Error(`Unhandled export phase: ${String(exhaustive)}`)
			}
		}
	}

	async clearAll(): Promise<{ ok: true }> {
		await this.ctx.storage.deleteAlarm().catch(() => {
			// Best effort: deleteAll below still clears persisted alarm state.
		})
		await this.ctx.storage.deleteAll()
		this.retentionAlarmArmed = false
		this.retentionIdleConfirmed = true
		this.runCountCache = null
		this.finishesSinceRetentionCache = null
		this.initializeSchema()
		this.setMeta(metaRunCountKey, 0)
		this.setMeta(metaFinishesSinceRetentionKey, 0)
		return { ok: true }
	}
}

export const RunLog = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	RunLogBase,
)

export type RunLogRpc = DurableObjectPitrRpc & {
	startRun: (input: { run: RunLogRowInput }) => Promise<{ ok: true }>
	claimRun: (input: { run: RunLogRowInput }) => Promise<{
		claimed: boolean
		run: RunRecord
	}>
	finishRun: (input: {
		run: RunLogRowInput
		logs: Array<RunLogEntryInput>
	}) => Promise<{ ok: true }>
	listRuns: (input: ListRunsInput) => Promise<RunRecordPage>
	updateRunErrorTriage: (
		input: UpdateRunErrorTriageInput,
	) => Promise<UpdateRunErrorTriageResult>
	bulkUpdateRunErrorTriage: (
		input: BulkUpdateRunErrorTriageInput,
	) => Promise<BulkUpdateRunErrorTriageResult>
	getRun: (input: {
		runId: string
	}) => Promise<{ run: RunRecord; logs: Array<RunRecordLog> } | null>
	getRunByIdempotencyKey: (input: {
		idempotencyKey: string
		surface?: RunSurface | null
	}) => Promise<RunRecord | null>
	deleteRunIfRunning: (input: {
		runId: string
	}) => Promise<{ deleted: boolean }>
	claimPackageInvocation: (input: {
		invocation: PackageInvocationClaimInput
		staleBefore: string
		run: RunLogRowInput | null
	}) => Promise<PackageInvocationClaimResult>
	getPackageInvocation: (
		input: PackageInvocationLedgerKey,
	) => Promise<PackageInvocationLedgerRecord | null>
	finishPackageInvocation: (input: {
		invocationId: string
		claimUpdatedAt: string
		status: 'completed' | 'failed'
		responseJson: string | null
		run: RunLogRowInput | null
		logs: Array<RunLogEntryInput>
	}) => Promise<{
		ledgerUpdated: boolean
		record: PackageInvocationLedgerRecord | null
	}>
	releasePackageInvocation: (input: {
		invocationId: string
		claimUpdatedAt: string
		runId: string | null
	}) => Promise<{
		released: boolean
		record: PackageInvocationLedgerRecord | null
	}>
	upsertWorkflowProjection: (
		input: WorkflowProjectionUpsertInput,
	) => Promise<{ ok: true }>
	getWorkflowProjection: (input: {
		id: string
	}) => Promise<WorkflowProjectionRecord | null>
	findWorkflowProjectionByIdempotencyKey: (input: {
		idempotencyKey: string
		bindingName?: string | null
	}) => Promise<WorkflowProjectionRecord | null>
	findWorkflowProjectionByBindingIdempotencyKey: (input: {
		bindingName: string
		idempotencyKey: string
	}) => Promise<WorkflowProjectionRecord | null>
	listWorkflowProjections: (input: WorkflowProjectionListInput) => Promise<{
		projections: Array<WorkflowProjectionRecord>
		nextCursor: string | null
	}>
	countActiveWorkflowProjections: () => Promise<{ count: number }>
	reserveWorkflowProjectionSlot: (
		input: WorkflowProjectionUpsertInput,
	) => Promise<WorkflowProjectionReserveResult>
	deleteWorkflowProjectionIfCreating: (input: {
		id: string
	}) => Promise<{ deleted: boolean }>
	upsertJobRunObservability: (
		input: JobRunObservabilityUpsertInput,
	) => Promise<JobRunObservabilityRecord>
	getJobRunObservability: (input: {
		jobId: string
	}) => Promise<JobRunObservabilityRecord | null>
	getJobRunObservabilityBatch: (input: {
		jobIds: Array<string>
	}) => Promise<Array<JobRunObservabilityRecord>>
	getAdminInsightsSnapshot: () => Promise<RunLogAdminInsightsSnapshot>
	listPackageRunSuccesses: () => Promise<Array<PackageRunSuccessRecord>>
	listActivationMilestones: () => Promise<Array<ActivationMilestoneRecord>>
	summarize: (input: { since: string }) => Promise<RunRecordSummary>
	listStorageIds: () => Promise<Array<string>>
	exportRuns: (input: ExportRunsInput) => Promise<ExportRunsResult>
	clearAll: () => Promise<{ ok: true }>
}
