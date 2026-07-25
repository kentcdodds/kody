import { toJsonSafeValue } from '@kody-internal/shared/json-safe-value.ts'
import { recordSuccessfulPackageRun } from '#worker/usage/activation.ts'

export const packageRuntimeSurfaceValues = [
	'export',
	'subscription',
	'app_fetch',
	'app_realtime',
	'service',
	'job',
	'workflow',
	'retriever',
] as const

export type PackageRuntimeSurface = (typeof packageRuntimeSurfaceValues)[number]

export const packageRuntimeStatusValues = [
	'running',
	'success',
	'error',
] as const

export type PackageRuntimeStatus = (typeof packageRuntimeStatusValues)[number]

export const packageRuntimeLogLevelValues = [
	'debug',
	'info',
	'log',
	'warn',
	'error',
] as const

export type PackageRuntimeLogLevel =
	(typeof packageRuntimeLogLevelValues)[number]

export type PackageRuntimeDebugContext = {
	packageId: string
	kodyId: string
	sourceId?: string | null
	publishedCommit?: string | null
	surface: PackageRuntimeSurface
	name?: string | null
	storageId?: string | null
	jobId?: string | null
	workflowId?: string | null
	invocationId?: string | null
	sessionId?: string | null
	idempotencyKey?: string | null
	parentRunId?: string | null
	metadata?: Record<string, unknown> | null
}

export type PackageRuntimeRunHandle = {
	id: string
	userId: string
	packageId: string
	startedAt: string
}

export type PackageRuntimeRunRecord = {
	id: string
	userId: string
	packageId: string
	kodyId: string
	sourceId: string | null
	publishedCommit: string | null
	surface: PackageRuntimeSurface
	name: string | null
	status: PackageRuntimeStatus
	startedAt: string
	finishedAt: string | null
	durationMs: number | null
	errorName: string | null
	errorMessage: string | null
	storageId: string | null
	jobId: string | null
	workflowId: string | null
	invocationId: string | null
	sessionId: string | null
	idempotencyKey: string | null
	parentRunId: string | null
	metadata: Record<string, unknown>
	createdAt: string
	updatedAt: string
}

export type PackageRuntimeLogRecord = {
	id: string
	runId: string
	userId: string
	packageId: string
	timestamp: string
	sequence: number
	level: PackageRuntimeLogLevel
	message: string
	fields: Record<string, unknown> | null
	createdAt: string
}

const maxPersistedLogEntries = 200
const maxPersistedTextBytes = 16 * 1024
const maxPersistedJsonBytes = 32 * 1024
const textEncoder = new TextEncoder()

function dbFromEnv(env: Env): D1Database | null {
	const maybeDb = (env as Partial<Env>).APP_DB
	return maybeDb ?? null
}

function normalizeOptionalString(value: string | null | undefined) {
	const trimmed = value?.trim()
	return trimmed && trimmed.length > 0 ? trimmed : null
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

function serializeJson(value: unknown, maxBytes = maxPersistedJsonBytes) {
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
	const parsed = JSON.parse(value) as unknown
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
	return parsed as Record<string, unknown>
}

function mapRunRow(row: Record<string, unknown>): PackageRuntimeRunRecord {
	return {
		id: String(row['id']),
		userId: String(row['user_id']),
		packageId: String(row['package_id']),
		kodyId: String(row['package_kody_id']),
		sourceId: row['source_id'] == null ? null : String(row['source_id']),
		publishedCommit:
			row['published_commit'] == null ? null : String(row['published_commit']),
		surface: String(row['surface']) as PackageRuntimeSurface,
		name: row['name'] == null ? null : String(row['name']),
		status: String(row['status']) as PackageRuntimeStatus,
		startedAt: String(row['started_at']),
		finishedAt: row['finished_at'] == null ? null : String(row['finished_at']),
		durationMs:
			row['duration_ms'] == null ? null : Number(row['duration_ms']) || 0,
		errorName: row['error_name'] == null ? null : String(row['error_name']),
		errorMessage:
			row['error_message'] == null ? null : String(row['error_message']),
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
		metadata: parseJsonRecord(row['metadata_json']),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

function mapLogRow(row: Record<string, unknown>): PackageRuntimeLogRecord {
	return {
		id: String(row['id']),
		runId: String(row['run_id']),
		userId: String(row['user_id']),
		packageId: String(row['package_id']),
		timestamp: String(row['timestamp']),
		sequence: Number(row['sequence']) || 0,
		level: String(row['level']) as PackageRuntimeLogLevel,
		message: String(row['message']),
		fields:
			row['fields_json'] == null ? null : parseJsonRecord(row['fields_json']),
		createdAt: String(row['created_at']),
	}
}

function getErrorFields(error: unknown) {
	if (!error) return { errorName: null, errorMessage: null }
	if (error instanceof Error) {
		return {
			errorName: error.name,
			errorMessage: truncateUtf8(error.message, maxPersistedTextBytes),
		}
	}
	if (typeof error === 'object' && error !== null) {
		const record = error as Record<string, unknown>
		const message = record['message']
		if (typeof message === 'string') {
			const name = record['name']
			return {
				errorName: typeof name === 'string' ? name : 'Error',
				errorMessage: truncateUtf8(message, maxPersistedTextBytes),
			}
		}
	}
	return {
		errorName: 'Unknown',
		errorMessage: truncateUtf8(String(error), maxPersistedTextBytes),
	}
}

function normalizeLogs(logs: Array<string> | undefined) {
	return (logs ?? []).slice(-maxPersistedLogEntries).map((message, index) => ({
		sequence: index,
		level: 'log' as const,
		message: truncateUtf8(String(message), maxPersistedTextBytes),
	}))
}

export async function beginPackageRuntimeRun(input: {
	env: Env
	userId?: string | null
	context?: PackageRuntimeDebugContext | null
}): Promise<PackageRuntimeRunHandle | null> {
	const db = dbFromEnv(input.env)
	const userId = normalizeOptionalString(input.userId ?? undefined)
	const context = input.context
	if (!db || !userId || !context) return null
	const packageId = normalizeOptionalString(context.packageId)
	const kodyId = normalizeOptionalString(context.kodyId)
	if (!packageId || !kodyId) return null
	const id = crypto.randomUUID()
	const now = new Date().toISOString()
	try {
		await db
			.prepare(
				`INSERT INTO package_runtime_runs (
					id, user_id, package_id, package_kody_id, source_id, published_commit,
					surface, name, status, started_at, finished_at, duration_ms,
					error_name, error_message, storage_id, job_id, workflow_id,
					invocation_id, session_id, idempotency_key, parent_run_id,
					metadata_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				id,
				userId,
				packageId,
				kodyId,
				normalizeOptionalString(context.sourceId),
				normalizeOptionalString(context.publishedCommit),
				context.surface,
				normalizeOptionalString(context.name),
				now,
				normalizeOptionalString(context.storageId),
				normalizeOptionalString(context.jobId),
				normalizeOptionalString(context.workflowId),
				normalizeOptionalString(context.invocationId),
				normalizeOptionalString(context.sessionId),
				normalizeOptionalString(context.idempotencyKey),
				normalizeOptionalString(context.parentRunId),
				serializeJson(context.metadata ?? {}),
				now,
				now,
			)
			.run()
		return { id, userId, packageId, startedAt: now }
	} catch (error) {
		console.warn('package-runtime-debug-start-failed', error)
		return null
	}
}

export async function finishPackageRuntimeRun(input: {
	env: Env
	handle: PackageRuntimeRunHandle | null
	status: Exclude<PackageRuntimeStatus, 'running'>
	logs?: Array<string>
	error?: unknown
}) {
	const db = dbFromEnv(input.env)
	if (!db || !input.handle) return
	const handle = input.handle
	const finishedAt = new Date().toISOString()
	const durationMs = Math.max(
		0,
		Date.parse(finishedAt) - Date.parse(handle.startedAt),
	)
	const { errorName, errorMessage } = getErrorFields(input.error)
	const logs = normalizeLogs(input.logs)
	if (logs.length > 0) {
		try {
			const statements = logs.map((log) =>
				db
					.prepare(
						`INSERT OR REPLACE INTO package_runtime_logs (
							id, run_id, user_id, package_id, timestamp, sequence, level,
							message, fields_json, created_at
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
					)
					.bind(
						`${handle.id}:${log.sequence}`,
						handle.id,
						handle.userId,
						handle.packageId,
						finishedAt,
						log.sequence,
						log.level,
						log.message,
						finishedAt,
					),
			)
			const dbWithBatch = db as D1Database & { batch?: D1Database['batch'] }
			if (dbWithBatch.batch) {
				await dbWithBatch.batch(statements)
			} else {
				await Promise.all(statements.map((statement) => statement.run()))
			}
		} catch (error) {
			console.warn('package-runtime-debug-logs-failed', error)
		}
	}
	try {
		await db
			.prepare(
				`UPDATE package_runtime_runs
				SET status = ?, finished_at = ?, duration_ms = ?,
					error_name = ?, error_message = ?, updated_at = ?
				WHERE id = ? AND user_id = ?`,
			)
			.bind(
				input.status,
				finishedAt,
				durationMs,
				errorName,
				errorMessage,
				finishedAt,
				handle.id,
				handle.userId,
			)
			.run()
	} catch (error) {
		console.warn('package-runtime-debug-status-failed', error)
	}

	// Every package surface (export, job, subscription, app, service, workflow,
	// retriever) finishes here, so this is the one place activation can observe
	// a package actually working.
	if (input.status === 'success') {
		await recordSuccessfulPackageRun(input.env, {
			userId: handle.userId,
			packageId: handle.packageId,
		})
	}
}

export async function listPackageRuntimeRuns(input: {
	env: Env
	userId: string
	packageId?: string | null
	surface?: PackageRuntimeSurface | null
	limit?: number | null
}): Promise<Array<PackageRuntimeRunRecord>> {
	const db = dbFromEnv(input.env)
	if (!db) return []
	const clauses = ['user_id = ?']
	const params: Array<string | number> = [input.userId]
	const packageId = normalizeOptionalString(input.packageId)
	if (packageId) {
		clauses.push('package_id = ?')
		params.push(packageId)
	}
	if (input.surface) {
		clauses.push('surface = ?')
		params.push(input.surface)
	}
	const limit = Math.min(Math.max(input.limit ?? 25, 1), 100)
	params.push(limit)
	const result = await db
		.prepare(
			`SELECT *
			FROM package_runtime_runs
			WHERE ${clauses.join(' AND ')}
			ORDER BY started_at DESC, id DESC
			LIMIT ?`,
		)
		.bind(...params)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map(mapRunRow)
}

export async function getPackageRuntimeRun(input: {
	env: Env
	userId: string
	runId: string
}): Promise<{
	run: PackageRuntimeRunRecord
	logs: Array<PackageRuntimeLogRecord>
} | null> {
	const db = dbFromEnv(input.env)
	if (!db) return null
	const runRow = await db
		.prepare(
			`SELECT *
			FROM package_runtime_runs
			WHERE id = ? AND user_id = ?
			LIMIT 1`,
		)
		.bind(input.runId, input.userId)
		.first<Record<string, unknown>>()
	if (!runRow) return null
	const logsResult = await db
		.prepare(
			`SELECT *
			FROM package_runtime_logs
			WHERE run_id = ? AND user_id = ?
			ORDER BY sequence ASC`,
		)
		.bind(input.runId, input.userId)
		.all<Record<string, unknown>>()
	return {
		run: mapRunRow(runRow),
		logs: (logsResult.results ?? []).map(mapLogRow),
	}
}
