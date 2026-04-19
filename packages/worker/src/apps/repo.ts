import {
	type AppJobRecord,
	type AppRecord,
	type PersistedAppCallerContext,
} from './types.ts'

function parseJson<T>(value: string | null, fallback: T): T {
	if (!value) return fallback
	try {
		return JSON.parse(value) as T
	} catch {
		return fallback
	}
}

function serializeApp(app: AppRecord) {
	return {
		id: app.id,
		user_id: app.userId,
		title: app.title,
		description: app.description,
		source_id: app.sourceId,
		published_commit: app.publishedCommit ?? null,
		repo_check_policy_json: app.repoCheckPolicy
			? JSON.stringify(app.repoCheckPolicy)
			: null,
		hidden: app.hidden ? 1 : 0,
		keywords_json: JSON.stringify(app.keywords),
		search_text: app.searchText ?? null,
		parameters_json: app.parameters ? JSON.stringify(app.parameters) : null,
		has_client: app.hasClient ? 1 : 0,
		has_server: app.hasServer ? 1 : 0,
		tasks_json: JSON.stringify(app.tasks),
		jobs_json: JSON.stringify(app.jobs),
		created_at: app.createdAt,
		updated_at: app.updatedAt,
	}
}

function mapRow(row: Record<string, unknown>): AppRecord {
	const record: AppRecord = {
		version: 1,
		id: String(row['id']),
		userId: String(row['user_id']),
		title: String(row['title']),
		description: String(row['description']),
		sourceId: String(row['source_id']),
		publishedCommit:
			row['published_commit'] == null ? null : String(row['published_commit']),
		repoCheckPolicy: parseJson(
			row['repo_check_policy_json'] == null
				? null
				: String(row['repo_check_policy_json']),
			undefined,
		),
		hidden: Number(row['hidden']) === 1,
		keywords: parseJson<Array<string>>(String(row['keywords_json'] ?? '[]'), []),
		searchText: row['search_text'] == null ? null : String(row['search_text']),
		parameters: parseJson(
			row['parameters_json'] == null ? null : String(row['parameters_json']),
			null,
		),
		hasClient: Number(row['has_client']) === 1,
		hasServer: Number(row['has_server']) === 1,
		tasks: parseJson(String(row['tasks_json'] ?? '[]'), []),
		jobs: parseJson<Array<AppJobRecord>>(String(row['jobs_json'] ?? '[]'), []).map(
			(job) => ({
				...job,
				callerContext:
					job.callerContext == null
						? null
						: (job.callerContext as PersistedAppCallerContext),
			}),
		),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
	return record
}

export async function insertAppRow(db: D1Database, app: AppRecord) {
	const serialized = serializeApp(app)
	await db
		.prepare(
			`INSERT INTO apps (
				id, user_id, title, description, source_id, published_commit,
				repo_check_policy_json, hidden, keywords_json, search_text,
				parameters_json, has_client, has_server, tasks_json, jobs_json,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			serialized.id,
			serialized.user_id,
			serialized.title,
			serialized.description,
			serialized.source_id,
			serialized.published_commit,
			serialized.repo_check_policy_json,
			serialized.hidden,
			serialized.keywords_json,
			serialized.search_text,
			serialized.parameters_json,
			serialized.has_client,
			serialized.has_server,
			serialized.tasks_json,
			serialized.jobs_json,
			serialized.created_at,
			serialized.updated_at,
		)
		.run()
}

export async function updateAppRow(db: D1Database, userId: string, app: AppRecord) {
	const serialized = serializeApp(app)
	const result = await db
		.prepare(
			`UPDATE apps SET
				title = ?, description = ?, source_id = ?, published_commit = ?,
				repo_check_policy_json = ?, hidden = ?, keywords_json = ?, search_text = ?,
				parameters_json = ?, has_client = ?, has_server = ?, tasks_json = ?,
				jobs_json = ?, updated_at = ?
			WHERE id = ? AND user_id = ?`,
		)
		.bind(
			serialized.title,
			serialized.description,
			serialized.source_id,
			serialized.published_commit,
			serialized.repo_check_policy_json,
			serialized.hidden,
			serialized.keywords_json,
			serialized.search_text,
			serialized.parameters_json,
			serialized.has_client,
			serialized.has_server,
			serialized.tasks_json,
			serialized.jobs_json,
			serialized.updated_at,
			serialized.id,
			userId,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function getAppRowById(
	db: D1Database,
	userId: string,
	appId: string,
): Promise<AppRecord | null> {
	const result = await db
		.prepare(`SELECT * FROM apps WHERE id = ? AND user_id = ?`)
		.bind(appId, userId)
		.first<Record<string, unknown>>()
	return result ? mapRow(result) : null
}

export async function listAppRowsByUserId(
	db: D1Database,
	userId: string,
): Promise<Array<AppRecord>> {
	const { results } = await db
		.prepare(
			`SELECT * FROM apps WHERE user_id = ? ORDER BY updated_at DESC, created_at DESC`,
		)
		.bind(userId)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapRow)
}

export async function listAllApps(db: D1Database): Promise<Array<AppRecord>> {
	const { results } = await db.prepare(`SELECT * FROM apps`).all<Record<string, unknown>>()
	return (results ?? []).map(mapRow)
}

export async function findAppRowByJobId(
	db: D1Database,
	userId: string,
	jobId: string,
): Promise<AppRecord | null> {
	const result = await db
		.prepare(
			`SELECT * FROM apps
			WHERE user_id = ?
				AND (
					json_array_length(jobs_json) > 0
					AND EXISTS (
						SELECT 1
						FROM json_each(apps.jobs_json) AS job
						WHERE json_extract(job.value, '$.id') = ?
					)
				)
			LIMIT 1`,
		)
		.bind(userId, jobId)
		.first<Record<string, unknown>>()
	return result ? mapRow(result) : null
}

export async function deleteAppRow(
	db: D1Database,
	userId: string,
	appId: string,
): Promise<boolean> {
	const result = await db
		.prepare(`DELETE FROM apps WHERE id = ? AND user_id = ?`)
		.bind(appId, userId)
		.run()
	return (result.meta.changes ?? 0) > 0
}
