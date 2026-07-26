import * as Sentry from '@sentry/cloudflare'
import { DurableObject } from 'cloudflare:workers'
import { toJsonSafeValue } from '@kody-internal/shared/json-safe-value.ts'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import {
	type RunLogLevel,
	type RunRecord,
	type RunRecordLog,
	type RunRecordPage,
	type RunRecordSummary,
	type RunStatus,
	type RunSurface,
	runRecordMaxJsonBytes,
	runRecordMaxLogEntriesPerRun,
	runRecordMaxRunsPerUser,
	runRecordMaxTextBytes,
	runRecordDefaultPageSize,
	runRecordMaxPageSize,
	runRecordRetentionAlarmMs,
	runRecordRetentionDays,
	runRecordRetentionEveryNFinishes,
	runRecordStaleRunningTtlMs,
	runSurfaceValues,
} from './types.ts'

const textEncoder = new TextEncoder()
const maxAgeDeletesPerFinish = 100
const maxExcessDeletesPerFinish = 100
const maxStaleRunningReconcilesPerPass = 100

const metaRunCountKey = 'run_count'
const metaFinishesSinceRetentionKey = 'finishes_since_retention'

const staleRunningErrorName = 'Interrupted'
const staleRunningErrorMessage =
	'Run did not finish; outcome unknown (reconciled after stale running TTL).'

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

type ListRunsInput = {
	surface?: RunSurface | null
	status?: RunStatus | null
	packageId?: string | null
	jobId?: string | null
	name?: string | null
	since?: string | null
	limit: number
	cursor?: string | null
}

type ExportRunsInput = {
	pageSize: number
	startAfter?: string | null
}

type CursorPayload = {
	startedAt: string
	id: string
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

function mapRunRow(
	row: Record<string, SqlStorageValue>,
	logCount: number,
): RunRecord {
	const surface = String(row['surface'] ?? '')
	const status = String(row['status'] ?? '')
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

function clampMetadataJson(metadataJson: string) {
	if (textEncoder.encode(metadataJson).length <= runRecordMaxJsonBytes) {
		return metadataJson
	}
	return serializeJson(parseJsonRecord(metadataJson))
}

class RunLogBase extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		this.ctx.blockConcurrencyWhile(async () => {
			this.initializeSchema()
			this.ensureRunCountMeta()
			const currentAlarm = await this.ctx.storage.getAlarm()
			if (currentAlarm == null) {
				await this.ctx.storage.setAlarm(Date.now() + runRecordRetentionAlarmMs)
			}
		})
	}

	private initializeSchema() {
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
				updated_at TEXT NOT NULL
			)
		`)
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS run_log_meta (
				key TEXT PRIMARY KEY NOT NULL,
				value INTEGER NOT NULL
			)
		`)
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
	}

	private ensureRunCountMeta() {
		if (this.getMeta(metaRunCountKey) != null) return
		const countRow = this.ctx.storage.sql
			.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM runs`)
			.one()
		this.setMeta(metaRunCountKey, Number(countRow.n ?? 0) || 0)
		if (this.getMeta(metaFinishesSinceRetentionKey) == null) {
			this.setMeta(metaFinishesSinceRetentionKey, 0)
		}
	}

	private adjustRunCount(delta: number) {
		if (delta === 0) return
		const current = this.getMeta(metaRunCountKey) ?? 0
		this.setMeta(metaRunCountKey, Math.max(0, current + delta))
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

	private upsertRun(run: RunLogRowInput, mode: 'ignore' | 'replace') {
		const metadataJson = clampMetadataJson(run.metadataJson || '{}')
		const statement =
			mode === 'ignore'
				? `INSERT OR IGNORE INTO runs (
					id, surface, status, name, package_id, package_kody_id, source_id,
					published_commit, storage_id, job_id, workflow_id, invocation_id,
					session_id, idempotency_key, parent_run_id, started_at, finished_at,
					duration_ms, error_name, error_message, metadata_json, created_at,
					updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				: `INSERT OR REPLACE INTO runs (
					id, surface, status, name, package_id, package_kody_id, source_id,
					published_commit, storage_id, job_id, workflow_id, invocation_id,
					session_id, idempotency_key, parent_run_id, started_at, finished_at,
					duration_ms, error_name, error_message, metadata_json, created_at,
					updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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

	/**
	 * Prefer marking stranded `running` rows terminal over deleting them: an
	 * interrupted attempt is useful history. `error` + Interrupted is used
	 * because the public status union has no dedicated unknown-outcome value;
	 * live "is it running?" state must not be read from these rows anyway.
	 */
	private reconcileStaleRunning() {
		const cutoff = new Date(
			Date.now() - runRecordStaleRunningTtlMs,
		).toISOString()
		const finishedAt = new Date().toISOString()
		const stale = this.ctx.storage.sql
			.exec<{ id: string; started_at: string }>(
				`SELECT id, started_at FROM runs
				WHERE status = 'running' AND started_at < ?
				ORDER BY started_at ASC
				LIMIT ?`,
				cutoff,
				maxStaleRunningReconcilesPerPass,
			)
			.toArray()
		for (const row of stale) {
			const startedMs = Date.parse(row.started_at)
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
				row.id,
			)
		}
	}

	private deleteOldestWithStatus(status: RunStatus, limit: number) {
		if (limit <= 0) return [] as Array<string>
		return this.ctx.storage.sql
			.exec<{ id: string }>(
				`SELECT id FROM runs
				WHERE status = ?
				ORDER BY started_at ASC
				LIMIT ?`,
				status,
				limit,
			)
			.toArray()
			.map((row) => row.id)
	}

	private enforceRetention() {
		this.reconcileStaleRunning()

		const cutoff = new Date(
			Date.now() - runRecordRetentionDays * 24 * 60 * 60 * 1000,
		).toISOString()
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

		const total = this.getMeta(metaRunCountKey) ?? 0
		const excess = total - runRecordMaxRunsPerUser
		if (excess > 0) {
			const deleteCount = Math.min(excess, maxExcessDeletesPerFinish)
			// Failure-last via status-scoped scans on idx_runs_status_started_id
			// instead of ORDER BY (status = 'error') expression sort.
			const ids: Array<string> = []
			ids.push(...this.deleteOldestWithStatus('success', deleteCount))
			if (ids.length < deleteCount) {
				ids.push(
					...this.deleteOldestWithStatus('running', deleteCount - ids.length),
				)
			}
			if (ids.length < deleteCount) {
				ids.push(
					...this.deleteOldestWithStatus('error', deleteCount - ids.length),
				)
			}
			this.deleteRunsByIds(ids)
		}

		this.setMeta(metaFinishesSinceRetentionKey, 0)
	}

	private maybeEnforceRetention() {
		const finishes = (this.getMeta(metaFinishesSinceRetentionKey) ?? 0) + 1
		this.setMeta(metaFinishesSinceRetentionKey, finishes)
		if (finishes >= runRecordRetentionEveryNFinishes) {
			this.enforceRetention()
		}
	}

	private async ensureRetentionAlarm() {
		const currentAlarm = await this.ctx.storage.getAlarm()
		if (currentAlarm == null) {
			await this.ctx.storage.setAlarm(Date.now() + runRecordRetentionAlarmMs)
		}
	}

	async alarm(): Promise<void> {
		this.enforceRetention()
		await this.ctx.storage.setAlarm(Date.now() + runRecordRetentionAlarmMs)
	}

	async startRun(input: { run: RunLogRowInput }): Promise<{ ok: true }> {
		const existed = this.runExists(input.run.id)
		this.upsertRun(input.run, 'ignore')
		if (!existed && this.runExists(input.run.id)) {
			this.adjustRunCount(1)
		}
		await this.ensureRetentionAlarm()
		return { ok: true }
	}

	async finishRun(input: {
		run: RunLogRowInput
		logs: Array<RunLogEntryInput>
	}): Promise<{ ok: true }> {
		const existed = this.runExists(input.run.id)
		this.upsertRun(input.run, 'replace')
		this.replaceLogs(input.run.id, input.logs)
		if (!existed) {
			this.adjustRunCount(1)
		}
		this.maybeEnforceRetention()
		await this.ensureRetentionAlarm()
		return { ok: true }
	}

	async listRuns(input: ListRunsInput): Promise<RunRecordPage> {
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
		const logs = this.ctx.storage.sql
			.exec<Record<string, SqlStorageValue>>(
				`SELECT * FROM run_logs WHERE run_id = ? ORDER BY sequence ASC`,
				input.runId,
			)
			.toArray()
			.map(mapLogRow)
		return {
			run: mapRunRow(row, Number(row['log_count'] ?? 0) || 0),
			logs,
		}
	}

	async summarize(input: { since: string }): Promise<RunRecordSummary> {
		const since = input.since
		const totals = this.ctx.storage.sql
			.exec<{ total: number; errors: number; running: number }>(
				`SELECT
					COUNT(*) AS total,
					SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
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
					SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors
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

	async exportRuns(input: ExportRunsInput): Promise<{
		runs: Array<RunRecord>
		logs: Array<RunRecordLog>
		nextStartAfter: string | null
		truncated: boolean
	}> {
		const pageSize = normalizePageSize(input.pageSize, runRecordDefaultPageSize)
		const startAfter = input.startAfter?.trim() || null
		const rows = (
			startAfter
				? this.ctx.storage.sql.exec<Record<string, SqlStorageValue>>(
						`SELECT r.*,
							(SELECT COUNT(*) FROM run_logs l WHERE l.run_id = r.id) AS log_count
						FROM runs r
						WHERE r.id > ?
						ORDER BY r.id ASC
						LIMIT ?`,
						startAfter,
						pageSize + 1,
					)
				: this.ctx.storage.sql.exec<Record<string, SqlStorageValue>>(
						`SELECT r.*,
							(SELECT COUNT(*) FROM run_logs l WHERE l.run_id = r.id) AS log_count
						FROM runs r
						ORDER BY r.id ASC
						LIMIT ?`,
						pageSize + 1,
					)
		).toArray()
		const truncated = rows.length > pageSize
		const pageRows = truncated ? rows.slice(0, pageSize) : rows
		const runs = pageRows.map((row) =>
			mapRunRow(row, Number(row['log_count'] ?? 0) || 0),
		)
		const runIds = runs.map((run) => run.id)
		const logs: Array<RunRecordLog> = []
		for (const runId of runIds) {
			const runLogs = this.ctx.storage.sql
				.exec<Record<string, SqlStorageValue>>(
					`SELECT * FROM run_logs WHERE run_id = ? ORDER BY sequence ASC`,
					runId,
				)
				.toArray()
				.map(mapLogRow)
			logs.push(...runLogs)
		}
		const last = pageRows[pageRows.length - 1]
		return {
			runs,
			logs,
			nextStartAfter: truncated && last ? String(last['id']) : null,
			truncated,
		}
	}

	async clearAll(): Promise<{ ok: true }> {
		await this.ctx.storage.deleteAlarm().catch(() => {
			// Best effort: deleteAll below still clears persisted alarm state.
		})
		await this.ctx.storage.deleteAll()
		this.initializeSchema()
		this.setMeta(metaRunCountKey, 0)
		this.setMeta(metaFinishesSinceRetentionKey, 0)
		await this.ctx.storage.setAlarm(Date.now() + runRecordRetentionAlarmMs)
		return { ok: true }
	}
}

export const RunLog = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	RunLogBase,
)

export type RunLogRpc = {
	startRun: (input: { run: RunLogRowInput }) => Promise<{ ok: true }>
	finishRun: (input: {
		run: RunLogRowInput
		logs: Array<RunLogEntryInput>
	}) => Promise<{ ok: true }>
	listRuns: (input: ListRunsInput) => Promise<RunRecordPage>
	getRun: (input: {
		runId: string
	}) => Promise<{ run: RunRecord; logs: Array<RunRecordLog> } | null>
	summarize: (input: { since: string }) => Promise<RunRecordSummary>
	listStorageIds: () => Promise<Array<string>>
	exportRuns: (input: ExportRunsInput) => Promise<{
		runs: Array<RunRecord>
		logs: Array<RunRecordLog>
		nextStartAfter: string | null
		truncated: boolean
	}>
	clearAll: () => Promise<{ ok: true }>
}
