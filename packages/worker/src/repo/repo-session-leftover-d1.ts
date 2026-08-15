import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { repoSessionRowSchema, type RepoSessionRow } from './types.ts'

export function isMissingRepoSessionsTable(error: unknown): boolean {
	return /no such table:\s*['"]?(?:main\.)?repo_sessions['"]?(?=$|[\s:])/i.test(
		getErrorMessage(error),
	)
}

function requiredString(row: Record<string, unknown>, key: string): string {
	const value = row[key]
	if (value == null) {
		throw new Error(`Leftover repo_sessions row is missing ${key}.`)
	}
	return String(value)
}

function optionalString(
	row: Record<string, unknown>,
	key: string,
): string | null {
	const value = row[key]
	return value == null ? null : String(value)
}

function mapRepoSessionRow(row: Record<string, unknown>): RepoSessionRow {
	return repoSessionRowSchema.parse({
		id: requiredString(row, 'id'),
		user_id: requiredString(row, 'user_id'),
		source_id: requiredString(row, 'source_id'),
		source_repo_id: requiredString(row, 'source_repo_id'),
		session_branch: requiredString(row, 'session_branch'),
		source_branch: requiredString(row, 'source_branch'),
		base_commit: requiredString(row, 'base_commit'),
		source_root: requiredString(row, 'source_root'),
		conversation_id: optionalString(row, 'conversation_id'),
		status: requiredString(row, 'status'),
		expires_at: optionalString(row, 'expires_at'),
		last_checkpoint_at: optionalString(row, 'last_checkpoint_at'),
		last_checkpoint_commit: optionalString(row, 'last_checkpoint_commit'),
		last_check_run_id: optionalString(row, 'last_check_run_id'),
		last_check_tree_hash: optionalString(row, 'last_check_tree_hash'),
		created_at: requiredString(row, 'created_at'),
		updated_at: requiredString(row, 'updated_at'),
	})
}

async function queryLeftoverD1RepoSessions(
	run: () => Promise<Array<Record<string, unknown>>>,
): Promise<Array<RepoSessionRow>> {
	try {
		return (await run()).map(mapRepoSessionRow)
	} catch (error) {
		if (isMissingRepoSessionsTable(error)) return []
		throw error
	}
}

export async function getLeftoverD1RepoSession(input: {
	db: D1Database
	userId: string
	sessionId: string
}): Promise<RepoSessionRow | null> {
	try {
		const result = await input.db
			.prepare(`SELECT * FROM repo_sessions WHERE id = ? AND user_id = ?`)
			.bind(input.sessionId, input.userId)
			.first<Record<string, unknown>>()
		return result ? mapRepoSessionRow(result) : null
	} catch (error) {
		if (isMissingRepoSessionsTable(error)) return null
		throw error
	}
}

export async function listLeftoverD1RepoSessionsByUser(input: {
	db: D1Database
	userId: string
	afterId?: string
	limit?: number
}): Promise<Array<RepoSessionRow>> {
	return queryLeftoverD1RepoSessions(async () => {
		const { results } = await input.db
			.prepare(
				`SELECT * FROM repo_sessions
				WHERE user_id = ? AND id > ?
				ORDER BY id ASC
				LIMIT ?`,
			)
			.bind(input.userId, input.afterId ?? '', input.limit ?? 500)
			.all<Record<string, unknown>>()
		return results ?? []
	})
}

export async function countLeftoverD1RepoSessionsByUser(input: {
	db: D1Database
	userId: string
}): Promise<number> {
	try {
		const row = await input.db
			.prepare(`SELECT COUNT(*) AS count FROM repo_sessions WHERE user_id = ?`)
			.bind(input.userId)
			.first<{ count: number }>()
		return Number(row?.count ?? 0)
	} catch (error) {
		if (isMissingRepoSessionsTable(error)) return 0
		throw error
	}
}

export async function listLeftoverD1RepoSessionsBySource(input: {
	db: D1Database
	userId: string
	sourceId: string
}): Promise<Array<RepoSessionRow>> {
	return queryLeftoverD1RepoSessions(async () => {
		const { results } = await input.db
			.prepare(
				`SELECT * FROM repo_sessions
				WHERE user_id = ? AND source_id = ?
				ORDER BY updated_at DESC`,
			)
			.bind(input.userId, input.sourceId)
			.all<Record<string, unknown>>()
		return results ?? []
	})
}

/** Session ids only — used for storage-bucket inventory when leftover rows may be incomplete. */
export async function listLeftoverD1RepoSessionIdsBySource(input: {
	db: D1Database
	userId: string
	sourceId: string
}): Promise<Array<string>> {
	return listLeftoverD1RepoSessionIds({
		db: input.db,
		sql: `SELECT id FROM repo_sessions
			WHERE user_id = ? AND source_id = ?`,
		params: [input.userId, input.sourceId],
	})
}

export async function listLeftoverD1RepoSessionIdsByUser(input: {
	db: D1Database
	userId: string
}): Promise<Array<string>> {
	return listLeftoverD1RepoSessionIds({
		db: input.db,
		sql: `SELECT id FROM repo_sessions WHERE user_id = ?`,
		params: [input.userId],
	})
}

async function listLeftoverD1RepoSessionIds(input: {
	db: D1Database
	sql: string
	params: Array<string>
}): Promise<Array<string>> {
	try {
		const { results } = await input.db
			.prepare(input.sql)
			.bind(...input.params)
			.all<{ id: string }>()
		return (results ?? []).map((row) => row.id)
	} catch (error) {
		if (isMissingRepoSessionsTable(error)) return []
		throw error
	}
}

async function runLeftoverD1Delete(input: {
	db: D1Database
	sql: string
	params: Array<string>
}): Promise<void> {
	try {
		await input.db
			.prepare(input.sql)
			.bind(...input.params)
			.run()
	} catch (error) {
		if (isMissingRepoSessionsTable(error)) return
		throw error
	}
}

export async function deleteLeftoverD1RepoSession(input: {
	db: D1Database
	userId: string
	sessionId: string
}): Promise<void> {
	await runLeftoverD1Delete({
		db: input.db,
		sql: `DELETE FROM repo_sessions WHERE id = ? AND user_id = ?`,
		params: [input.sessionId, input.userId],
	})
}

export async function deleteLeftoverD1RepoSessionsBySource(input: {
	db: D1Database
	userId: string
	sourceId: string
}): Promise<void> {
	await runLeftoverD1Delete({
		db: input.db,
		sql: `DELETE FROM repo_sessions WHERE user_id = ? AND source_id = ?`,
		params: [input.userId, input.sourceId],
	})
}

export async function deleteLeftoverD1RepoSessionsByUser(input: {
	db: D1Database
	userId: string
}): Promise<void> {
	await runLeftoverD1Delete({
		db: input.db,
		sql: `DELETE FROM repo_sessions WHERE user_id = ?`,
		params: [input.userId],
	})
}
