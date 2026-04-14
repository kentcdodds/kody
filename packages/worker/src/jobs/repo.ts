import { type JobRecord, type PersistedJobCallerContext } from './types.ts'

type JobRowRecord = {
	id: string
	user_id: string
	name: string
	kind: JobRecord['kind']
	code: string | null
	server_code: string | null
	server_code_id: string | null
	method_name: string | null
	params_json: string | null
	schedule_json: string
	timezone: string
	enabled: number
	kill_switch_enabled: number
	caller_context_json: string
	created_at: string
	updated_at: string
	last_run_at: string | null
	last_run_status: JobRecord['lastRunStatus'] | null
	last_run_error: string | null
	last_duration_ms: number | null
	next_run_at: string
	run_count: number
	success_count: number
	error_count: number
	run_history_json: string
}

export type JobRow = JobRowRecord & {
	record: JobRecord
	callerContextJson: string
	callerContext: PersistedJobCallerContext | null
}

function serializeJob(job: JobRecord) {
	return {
		id: job.id,
		name: job.name,
		kind: job.kind,
		code: job.code ?? null,
		server_code: job.serverCode ?? null,
		server_code_id: job.serverCodeId ?? null,
		method_name: job.methodName ?? null,
		params_json: job.params ? JSON.stringify(job.params) : null,
		schedule_json: JSON.stringify(job.schedule),
		timezone: job.timezone,
		enabled: job.enabled ? 1 : 0,
		kill_switch_enabled: job.killSwitchEnabled ? 1 : 0,
		created_at: job.createdAt,
		updated_at: job.updatedAt,
		last_run_at: job.lastRunAt ?? null,
		last_run_status: job.lastRunStatus ?? null,
		last_run_error: job.lastRunError ?? null,
		last_duration_ms: job.lastDurationMs ?? null,
		next_run_at: job.nextRunAt,
		run_count: job.runCount,
		success_count: job.successCount,
		error_count: job.errorCount,
		run_history_json: JSON.stringify(job.runHistory),
	}
}

function parseJson<T>(value: string | null, fallback: T): T {
	if (!value) return fallback
	try {
		return JSON.parse(value) as T
	} catch {
		return fallback
	}
}

function mapRow(row: Record<string, unknown>): JobRow {
	const record: JobRecord = {
		version: 1,
		id: String(row['id']),
		userId: String(row['user_id']),
		name: String(row['name']),
		kind: String(row['kind']) as JobRecord['kind'],
		code: row['code'] == null ? undefined : String(row['code']),
		serverCode:
			row['server_code'] == null ? undefined : String(row['server_code']),
		serverCodeId:
			row['server_code_id'] == null ? undefined : String(row['server_code_id']),
		methodName:
			row['method_name'] == null ? undefined : String(row['method_name']),
		params: parseJson<Record<string, unknown> | undefined>(
			row['params_json'] == null ? null : String(row['params_json']),
			undefined,
		),
		schedule: parseJson<JobRecord['schedule']>(
			String(row['schedule_json']),
			{
				type: 'once',
				runAt: String(row['next_run_at']),
			},
		),
		timezone: String(row['timezone']),
		enabled: Number(row['enabled']) === 1,
		killSwitchEnabled: Number(row['kill_switch_enabled']) === 1,
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
		lastRunAt: row['last_run_at'] == null ? undefined : String(row['last_run_at']),
		lastRunStatus:
			row['last_run_status'] == null
				? undefined
				: (String(row['last_run_status']) as JobRecord['lastRunStatus']),
		lastRunError:
			row['last_run_error'] == null ? undefined : String(row['last_run_error']),
		lastDurationMs:
			row['last_duration_ms'] == null ? undefined : Number(row['last_duration_ms']),
		nextRunAt: String(row['next_run_at']),
		runCount: Number(row['run_count']) || 0,
		successCount: Number(row['success_count']) || 0,
		errorCount: Number(row['error_count']) || 0,
		runHistory: parseJson<JobRecord['runHistory']>(
			String(row['run_history_json'] ?? '[]'),
			[],
		),
	}
	return {
		id: record.id,
		user_id: String(row['user_id']),
		name: record.name,
		kind: record.kind,
		code: record.code ?? null,
		server_code: record.serverCode ?? null,
		server_code_id: record.serverCodeId ?? null,
		method_name: record.methodName ?? null,
		params_json: row['params_json'] == null ? null : String(row['params_json']),
		schedule_json: String(row['schedule_json']),
		timezone: record.timezone,
		enabled: record.enabled ? 1 : 0,
		kill_switch_enabled: record.killSwitchEnabled ? 1 : 0,
		caller_context_json: String(row['caller_context_json']),
		created_at: record.createdAt,
		updated_at: record.updatedAt,
		last_run_at: record.lastRunAt ?? null,
		last_run_status: record.lastRunStatus ?? null,
		last_run_error: record.lastRunError ?? null,
		last_duration_ms: record.lastDurationMs ?? null,
		next_run_at: record.nextRunAt,
		run_count: record.runCount,
		success_count: record.successCount,
		error_count: record.errorCount,
		run_history_json: String(row['run_history_json'] ?? '[]'),
		record,
		callerContextJson: String(row['caller_context_json']),
		callerContext: parseJson<PersistedJobCallerContext | null>(
			row['caller_context_json'] == null
				? null
				: String(row['caller_context_json']),
			null,
		),
	}
}

export async function insertJobRow(input: {
	db: D1Database
	userId: string
	job: JobRecord
	callerContextJson: string
}) {
	const serialized = serializeJob(input.job)
	await input.db
		.prepare(
			`INSERT INTO jobs (
				id, user_id, name, kind, code, server_code, server_code_id,
				method_name, params_json, schedule_json, timezone, enabled,
				kill_switch_enabled, caller_context_json, created_at, updated_at,
				last_run_at, last_run_status, last_run_error, last_duration_ms,
				next_run_at, run_count, success_count, error_count, run_history_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			serialized.id,
			input.userId,
			serialized.name,
			serialized.kind,
			serialized.code,
			serialized.server_code,
			serialized.server_code_id,
			serialized.method_name,
			serialized.params_json,
			serialized.schedule_json,
			serialized.timezone,
			serialized.enabled,
			serialized.kill_switch_enabled,
			input.callerContextJson,
			serialized.created_at,
			serialized.updated_at,
			serialized.last_run_at,
			serialized.last_run_status,
			serialized.last_run_error,
			serialized.last_duration_ms,
			serialized.next_run_at,
			serialized.run_count,
			serialized.success_count,
			serialized.error_count,
			serialized.run_history_json,
		)
		.run()
}

export async function updateJobRow(input: {
	db: D1Database
	userId: string
	job: JobRecord
	callerContextJson: string
}) {
	const serialized = serializeJob(input.job)
	const result = await input.db
		.prepare(
			`UPDATE jobs SET
				name = ?, kind = ?, code = ?, server_code = ?, server_code_id = ?,
				method_name = ?, params_json = ?, schedule_json = ?, timezone = ?,
				enabled = ?, kill_switch_enabled = ?, caller_context_json = ?,
				updated_at = ?, last_run_at = ?, last_run_status = ?, last_run_error = ?,
				last_duration_ms = ?, next_run_at = ?, run_count = ?, success_count = ?,
				error_count = ?, run_history_json = ?
			WHERE id = ? AND user_id = ?`,
		)
		.bind(
			serialized.name,
			serialized.kind,
			serialized.code,
			serialized.server_code,
			serialized.server_code_id,
			serialized.method_name,
			serialized.params_json,
			serialized.schedule_json,
			serialized.timezone,
			serialized.enabled,
			serialized.kill_switch_enabled,
			input.callerContextJson,
			serialized.updated_at,
			serialized.last_run_at,
			serialized.last_run_status,
			serialized.last_run_error,
			serialized.last_duration_ms,
			serialized.next_run_at,
			serialized.run_count,
			serialized.success_count,
			serialized.error_count,
			serialized.run_history_json,
			serialized.id,
			input.userId,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function getJobRowById(
	db: D1Database,
	userId: string,
	jobId: string,
): Promise<JobRow | null> {
	const result = await db
		.prepare(`SELECT * FROM jobs WHERE id = ? AND user_id = ?`)
		.bind(jobId, userId)
		.first<Record<string, unknown>>()
	return result ? mapRow(result) : null
}

export async function listJobRowsByUserId(
	db: D1Database,
	userId: string,
): Promise<Array<JobRow>> {
	const { results } = await db
		.prepare(`SELECT * FROM jobs WHERE user_id = ? ORDER BY next_run_at ASC, name ASC`)
		.bind(userId)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapRow)
}

export async function listDueJobRows(
	db: D1Database,
	userId: string,
	nowIso: string,
): Promise<Array<JobRow>> {
	const { results } = await db
		.prepare(
			`SELECT * FROM jobs
			WHERE user_id = ?
				AND enabled = 1
				AND kill_switch_enabled = 0
				AND next_run_at <= ?
			ORDER BY next_run_at ASC, name ASC`,
		)
		.bind(userId, nowIso)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapRow)
}

export async function getNextRunnableJobRow(
	db: D1Database,
	userId: string,
): Promise<JobRow | null> {
	const result = await db
		.prepare(
			`SELECT * FROM jobs
			WHERE user_id = ?
				AND enabled = 1
				AND kill_switch_enabled = 0
			ORDER BY next_run_at ASC, name ASC
			LIMIT 1`,
		)
		.bind(userId)
		.first<Record<string, unknown>>()
	return result ? mapRow(result) : null
}

export async function deleteJobRow(
	db: D1Database,
	userId: string,
	jobId: string,
): Promise<boolean> {
	const result = await db
		.prepare(`DELETE FROM jobs WHERE id = ? AND user_id = ?`)
		.bind(jobId, userId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function listAllJobRows(db: D1Database): Promise<Array<JobRow>> {
	const { results } = await db
		.prepare(`SELECT * FROM jobs ORDER BY user_id ASC, next_run_at ASC, name ASC`)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapRow)
}
