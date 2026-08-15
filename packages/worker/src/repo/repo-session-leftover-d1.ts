import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { repoSessionRowSchema, type RepoSessionRow } from './types.ts'

export function isMissingRepoSessionsTable(error: unknown): boolean {
	return /no such table:\s*['"]?repo_sessions['"]?/i.test(
		getErrorMessage(error),
	)
}

function mapRepoSessionRow(row: Record<string, unknown>): RepoSessionRow {
	return repoSessionRowSchema.parse({
		id: String(row['id']),
		user_id: String(row['user_id']),
		source_id: String(row['source_id']),
		source_repo_id: String(row['source_repo_id']),
		session_branch: String(row['session_branch']),
		source_branch: String(row['source_branch']),
		base_commit: String(row['base_commit']),
		source_root: String(row['source_root']),
		conversation_id:
			row['conversation_id'] == null ? null : String(row['conversation_id']),
		status: String(row['status']),
		expires_at: row['expires_at'] == null ? null : String(row['expires_at']),
		last_checkpoint_at:
			row['last_checkpoint_at'] == null
				? null
				: String(row['last_checkpoint_at']),
		last_checkpoint_commit:
			row['last_checkpoint_commit'] == null
				? null
				: String(row['last_checkpoint_commit']),
		last_check_run_id:
			row['last_check_run_id'] == null
				? null
				: String(row['last_check_run_id']),
		last_check_tree_hash:
			row['last_check_tree_hash'] == null
				? null
				: String(row['last_check_tree_hash']),
		created_at: String(row['created_at']),
		updated_at: String(row['updated_at']),
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
}): Promise<Array<RepoSessionRow>> {
	return queryLeftoverD1RepoSessions(async () => {
		const { results } = await input.db
			.prepare(
				`SELECT * FROM repo_sessions
				WHERE user_id = ?
				ORDER BY updated_at DESC`,
			)
			.bind(input.userId)
			.all<Record<string, unknown>>()
		return results ?? []
	})
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
