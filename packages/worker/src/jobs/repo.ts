import {
	deleteAppRow,
	findAppRowByJobId,
	getAppRowById,
	insertAppRow,
	updateAppRow,
} from '#worker/apps/repo.ts'
import { type AppRecord } from '#worker/apps/types.ts'
import { createJobStorageId } from '#worker/storage-runner.ts'
import { type JobRecord, type PersistedJobCallerContext } from './types.ts'

type JobRowRecord = {
	id: string
	user_id: string
	name: string
	source_id: string
	published_commit: string | null
	repo_check_policy_json: string | null
	storage_id: string | null
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
		source_id: job.sourceId,
		published_commit: job.publishedCommit ?? null,
		repo_check_policy_json: job.repoCheckPolicy
			? JSON.stringify(job.repoCheckPolicy)
			: null,
		storage_id: job.storageId,
		params_json: job.params ? JSON.stringify(job.params) : null,
		schedule_json: JSON.stringify(job.schedule),
		timezone: job.timezone,
		enabled: job.enabled ? 1 : 0,
		kill_switch_enabled: job.killSwitchEnabled ? 1 : 0,
		caller_context_json: 'null',
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

function mapJobRecord(app: AppRecord, job: AppRecord['jobs'][number]): JobRow {
	const serialized = serializeJob({
		version: 1,
		id: job.id,
		userId: app.userId,
		name: job.name,
		sourceId: app.sourceId,
		publishedCommit: app.publishedCommit,
		repoCheckPolicy: app.repoCheckPolicy,
		storageId: job.storageId || createJobStorageId(job.id),
		params: job.params,
		schedule: job.schedule,
		timezone: job.timezone,
		enabled: job.enabled,
		killSwitchEnabled: job.killSwitchEnabled,
		createdAt: job.createdAt,
		updatedAt: job.updatedAt,
		lastRunAt: job.lastRunAt,
		lastRunStatus: job.lastRunStatus,
		lastRunError: job.lastRunError,
		lastDurationMs: job.lastDurationMs,
		nextRunAt: job.nextRunAt,
		runCount: job.runCount,
		successCount: job.successCount,
		errorCount: job.errorCount,
		runHistory: job.runHistory,
	})
	const record: JobRecord = {
		version: 1,
		id: job.id,
		userId: app.userId,
		name: job.name,
		sourceId: app.sourceId,
		publishedCommit: app.publishedCommit,
		repoCheckPolicy: app.repoCheckPolicy,
		storageId: serialized.storage_id ?? createJobStorageId(job.id),
		params: job.params,
		schedule: job.schedule,
		timezone: job.timezone,
		enabled: job.enabled,
		killSwitchEnabled: job.killSwitchEnabled,
		createdAt: job.createdAt,
		updatedAt: job.updatedAt,
		lastRunAt: job.lastRunAt,
		lastRunStatus: job.lastRunStatus,
		lastRunError: job.lastRunError,
		lastDurationMs: job.lastDurationMs,
		nextRunAt: job.nextRunAt,
		runCount: job.runCount,
		successCount: job.successCount,
		errorCount: job.errorCount,
		runHistory: job.runHistory,
	}
	return {
		...serialized,
		user_id: app.userId,
		record,
		callerContextJson: serialized.caller_context_json ?? 'null',
		callerContext: job.callerContext ?? null,
	}
}

function appWithUpdatedJob(app: AppRecord, job: JobRecord): AppRecord {
	const existingJob = app.jobs.find((candidate) => candidate.id === job.id)
	const nextJob = {
		id: job.id,
		name: job.name,
		title: existingJob?.title ?? job.name,
		description: existingJob?.description ?? job.name,
		task: existingJob?.task ?? 'default',
		params: job.params,
		callerContext: existingJob?.callerContext ?? null,
		schedule: job.schedule,
		timezone: job.timezone,
		enabled: job.enabled,
		killSwitchEnabled: job.killSwitchEnabled,
		storageId: job.storageId,
		lastRunAt: job.lastRunAt,
		lastRunStatus: job.lastRunStatus,
		lastRunError: job.lastRunError,
		lastDurationMs: job.lastDurationMs,
		nextRunAt: job.nextRunAt,
		runCount: job.runCount,
		successCount: job.successCount,
		errorCount: job.errorCount,
		runHistory: job.runHistory,
		createdAt: job.createdAt,
		updatedAt: job.updatedAt,
	}
	const existingIndex = app.jobs.findIndex((candidate) => candidate.id === job.id)
	const nextJobs =
		existingIndex >= 0
			? app.jobs.map((candidate, index) =>
					index === existingIndex ? nextJob : candidate,
				)
			: [...app.jobs, nextJob]
	return {
		...app,
		jobs: nextJobs,
		hasServer: app.hasServer,
		hasClient: app.hasClient,
		updatedAt: job.updatedAt,
	}
}

export async function insertJobRow(input: {
	db: D1Database
	userId: string
	job: JobRecord
	callerContextJson: string
}) {
	const appId = input.job.id
	await insertAppRow(input.db, {
		version: 1,
		id: appId,
		userId: input.userId,
		title: input.job.name,
		description: input.job.name,
		sourceId: input.job.sourceId,
		publishedCommit: input.job.publishedCommit,
		repoCheckPolicy: input.job.repoCheckPolicy,
		hidden: true,
		keywords: ['job', 'scheduled'],
		searchText: input.job.name,
		parameters: null,
		hasClient: false,
		hasServer: false,
		tasks: [
			{
				name: 'default',
				title: input.job.name,
				description: input.job.name,
				entrypoint: 'src/tasks/default.ts',
			},
		],
		jobs: [
			{
				id: input.job.id,
				name: input.job.name,
				title: input.job.name,
				description: input.job.name,
				task: 'default',
				params: input.job.params,
				callerContext: parseJson(input.callerContextJson, null),
				schedule: input.job.schedule,
				timezone: input.job.timezone,
				enabled: input.job.enabled,
				killSwitchEnabled: input.job.killSwitchEnabled,
				storageId: input.job.storageId,
				lastRunAt: input.job.lastRunAt,
				lastRunStatus: input.job.lastRunStatus,
				lastRunError: input.job.lastRunError,
				lastDurationMs: input.job.lastDurationMs,
				nextRunAt: input.job.nextRunAt,
				runCount: input.job.runCount,
				successCount: input.job.successCount,
				errorCount: input.job.errorCount,
				runHistory: input.job.runHistory,
				createdAt: input.job.createdAt,
				updatedAt: input.job.updatedAt,
			},
		],
		createdAt: input.job.createdAt,
		updatedAt: input.job.updatedAt,
	})
}

function parseJobJson(value: string | null): AppRecord['jobs'][number] | null {
	return parseJson(value, null)
}

async function loadAppJobRows(input: {
	db: D1Database
	userId: string
	query: string
	bindings: Array<unknown>
}): Promise<Array<JobRow>> {
	const { results } = await input.db
		.prepare(input.query)
		.bind(...input.bindings)
		.all<Record<string, unknown>>()
	const appCache = new Map<string, AppRecord>()
	const rows: Array<JobRow> = []
	for (const row of results ?? []) {
		const job = parseJobJson(
			typeof row['job_json'] === 'string' ? row['job_json'] : null,
		)
		if (!job) continue
		const appId = String(row['app_id'])
		let app = appCache.get(appId)
		if (!app) {
			app = await getAppRowById(input.db, input.userId, appId)
			if (!app) continue
			appCache.set(appId, app)
		}
		rows.push(mapJobRecord(app, job))
	}
	return rows
}

export async function updateJobRow(input: {
	db: D1Database
	userId: string
	job: JobRecord
	callerContextJson: string
}) {
	const app =
		(await getAppRowById(input.db, input.userId, input.job.id)) ??
		(await findAppRowByJobId(input.db, input.userId, input.job.id))
	if (!app) return false
	return updateAppRow(
		input.db,
		input.userId,
		appWithUpdatedJob({
			...app,
			jobs: app.jobs.map((candidate) =>
				candidate.id === input.job.id
					? {
							...candidate,
							callerContext: parseJson(input.callerContextJson, null),
						}
					: candidate,
			),
		}, input.job),
	)
}

export async function getJobRowById(
	db: D1Database,
	userId: string,
	jobId: string,
): Promise<JobRow | null> {
	const app = await findAppRowByJobId(db, userId, jobId)
	if (!app) return null
	const job = app.jobs.find((candidate) => candidate.id === jobId)
	return job ? mapJobRecord(app, job) : null
}

export async function listJobRowsByUserId(
	db: D1Database,
	userId: string,
): Promise<Array<JobRow>> {
	const rows = await loadAppJobRows({
		db,
		userId,
		query: `SELECT apps.id AS app_id, json_each.value AS job_json
			FROM apps, json_each(apps.jobs_json)
			WHERE apps.user_id = ?
			ORDER BY json_extract(json_each.value, '$.nextRunAt') ASC,
				json_extract(json_each.value, '$.name') ASC`,
		bindings: [userId],
	})
	return rows
}

export async function listDueJobRows(
	db: D1Database,
	userId: string,
	nowIso: string,
): Promise<Array<JobRow>> {
	return loadAppJobRows({
		db,
		userId,
		query: `SELECT apps.id AS app_id, json_each.value AS job_json
			FROM apps, json_each(apps.jobs_json)
			WHERE apps.user_id = ?
				AND json_extract(json_each.value, '$.enabled') = 1
				AND json_extract(json_each.value, '$.killSwitchEnabled') = 0
				AND json_extract(json_each.value, '$.nextRunAt') <= ?
			ORDER BY json_extract(json_each.value, '$.nextRunAt') ASC,
				json_extract(json_each.value, '$.name') ASC`,
		bindings: [userId, nowIso],
	})
}

export async function getNextRunnableJobRow(
	db: D1Database,
	userId: string,
): Promise<JobRow | null> {
	const rows = await loadAppJobRows({
		db,
		userId,
		query: `SELECT apps.id AS app_id, json_each.value AS job_json
			FROM apps, json_each(apps.jobs_json)
			WHERE apps.user_id = ?
				AND json_extract(json_each.value, '$.enabled') = 1
				AND json_extract(json_each.value, '$.killSwitchEnabled') = 0
			ORDER BY json_extract(json_each.value, '$.nextRunAt') ASC,
				json_extract(json_each.value, '$.name') ASC
			LIMIT 1`,
		bindings: [userId],
	})
	return rows[0] ?? null
}

export async function deleteJobRow(
	db: D1Database,
	userId: string,
	jobId: string,
): Promise<boolean> {
	const app = await findAppRowByJobId(db, userId, jobId)
	if (!app) return false
	if (app.jobs.length === 1 && app.jobs[0]?.id === jobId && !app.hasClient && !app.hasServer) {
		return deleteAppRow(db, userId, app.id)
	}
	return updateAppRow(db, userId, {
		...app,
		jobs: app.jobs.filter((job) => job.id !== jobId),
		updatedAt: new Date().toISOString(),
	})
}
