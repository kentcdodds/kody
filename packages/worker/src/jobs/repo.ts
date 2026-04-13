import { type JobRecord, type JobSchedule } from './types.ts'

export async function insertJob(
	db: D1Database,
	row: {
		id: string
		user_id: string
		name: string
		serverCode: string
		serverCodeId: string
		schedule: JobSchedule
		timezone: string
		enabled: boolean
		created_at?: string
		updated_at?: string
	},
): Promise<void> {
	const now = new Date().toISOString()
	await db
		.prepare(
			`INSERT INTO jobs (
				id, user_id, name, server_code, server_code_id, schedule_json,
				timezone, enabled, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.user_id,
			row.name,
			row.serverCode,
			row.serverCodeId,
			JSON.stringify(row.schedule),
			row.timezone,
			row.enabled ? 1 : 0,
			row.created_at ?? now,
			row.updated_at ?? now,
		)
		.run()
}

export async function getJobById(
	db: D1Database,
	userId: string,
	jobId: string,
): Promise<JobRecord | null> {
	const row = await db
		.prepare(
			`SELECT id, user_id, name, server_code, server_code_id, schedule_json,
				timezone, enabled, created_at, updated_at
			FROM jobs
			WHERE id = ? AND user_id = ?
			LIMIT 1`,
		)
		.bind(jobId, userId)
		.first<Record<string, unknown>>()
	if (!row) return null
	return mapJobRow(row)
}

export async function listJobsByUserId(
	db: D1Database,
	userId: string,
): Promise<Array<JobRecord>> {
	const { results } = await db
		.prepare(
			`SELECT id, user_id, name, server_code, server_code_id, schedule_json,
				timezone, enabled, created_at, updated_at
			FROM jobs
			WHERE user_id = ?
			ORDER BY updated_at DESC, name ASC`,
		)
		.bind(userId)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapJobRow)
}

export async function updateJob(
	db: D1Database,
	userId: string,
	jobId: string,
	updates: Partial<{
		name: string
		serverCode: string
		serverCodeId: string
		schedule: JobSchedule
		timezone: string
		enabled: boolean
	}>,
): Promise<boolean> {
	const assignments: Array<string> = []
	const values: Array<unknown> = []
	function addAssignment(column: string, value: unknown) {
		assignments.push(`${column} = ?`)
		values.push(value)
	}

	if (updates.name !== undefined) {
		addAssignment('name', updates.name)
	}
	if (updates.serverCode !== undefined) {
		addAssignment('server_code', updates.serverCode)
	}
	if (updates.serverCodeId !== undefined) {
		addAssignment('server_code_id', updates.serverCodeId)
	}
	if (updates.schedule !== undefined) {
		addAssignment('schedule_json', JSON.stringify(updates.schedule))
	}
	if (updates.timezone !== undefined) {
		addAssignment('timezone', updates.timezone)
	}
	if (updates.enabled !== undefined) {
		addAssignment('enabled', updates.enabled ? 1 : 0)
	}
	addAssignment('updated_at', new Date().toISOString())

	const result = await db
		.prepare(
			`UPDATE jobs SET ${assignments.join(', ')} WHERE id = ? AND user_id = ?`,
		)
		.bind(...values, jobId, userId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function deleteJob(
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

function mapJobRow(row: Record<string, unknown>): JobRecord {
	return {
		id: String(row['id']),
		userId: String(row['user_id']),
		name: String(row['name']),
		serverCode: String(row['server_code']),
		serverCodeId: String(row['server_code_id']),
		schedule: parseJobSchedule(row['schedule_json']),
		timezone: String(row['timezone']),
		enabled:
			row['enabled'] === 1 || row['enabled'] === '1' || row['enabled'] === true,
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

function parseJobSchedule(raw: unknown): JobSchedule {
	if (typeof raw !== 'string' || !raw.trim()) {
		throw new Error('Stored job schedule is missing.')
	}
	const parsed = JSON.parse(raw) as unknown
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('Stored job schedule must be an object.')
	}
	if ('cron' in parsed && typeof parsed['cron'] === 'string') {
		return { cron: parsed['cron'] }
	}
	if (
		'intervalMs' in parsed &&
		typeof parsed['intervalMs'] === 'number' &&
		Number.isFinite(parsed['intervalMs'])
	) {
		return { intervalMs: parsed['intervalMs'] }
	}
	throw new Error('Stored job schedule has an unsupported shape.')
}
