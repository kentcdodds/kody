import { repoSessionRowSchema, type RepoSessionRow } from './types.ts'

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

export async function insertRepoSession(
	db: D1Database,
	row: RepoSessionRow,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO repo_sessions (
				id, user_id, source_id, source_repo_id, session_branch, source_branch, base_commit, source_root, conversation_id, status, expires_at,
				last_checkpoint_at, last_checkpoint_commit, last_check_run_id,
				last_check_tree_hash, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.user_id,
			row.source_id,
			row.source_repo_id,
			row.session_branch,
			row.source_branch,
			row.base_commit,
			row.source_root,
			row.conversation_id,
			row.status,
			row.expires_at,
			row.last_checkpoint_at,
			row.last_checkpoint_commit,
			row.last_check_run_id,
			row.last_check_tree_hash,
			row.created_at,
			row.updated_at,
		)
		.run()
}

export async function getRepoSessionById(
	db: D1Database,
	id: string,
): Promise<RepoSessionRow | null> {
	const result = await db
		.prepare(`SELECT * FROM repo_sessions WHERE id = ?`)
		.bind(id)
		.first<Record<string, unknown>>()
	return result ? mapRepoSessionRow(result) : null
}

export async function getActiveRepoSessionByConversation(
	db: D1Database,
	input: {
		userId: string
		conversationId: string
	},
): Promise<RepoSessionRow | null> {
	const result = await db
		.prepare(
			`SELECT * FROM repo_sessions
			WHERE user_id = ?
				AND conversation_id = ?
				AND status = 'active'
			ORDER BY updated_at DESC
			LIMIT 1`,
		)
		.bind(input.userId, input.conversationId)
		.first<Record<string, unknown>>()
	return result ? mapRepoSessionRow(result) : null
}

export async function listRepoSessionsBySource(
	db: D1Database,
	input: {
		userId: string
		sourceId: string
	},
): Promise<Array<RepoSessionRow>> {
	const { results } = await db
		.prepare(
			`SELECT * FROM repo_sessions
			WHERE user_id = ? AND source_id = ?
			ORDER BY updated_at DESC`,
		)
		.bind(input.userId, input.sourceId)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapRepoSessionRow)
}

export async function listRepoSessionsByUser(
	db: D1Database,
	userId: string,
): Promise<Array<RepoSessionRow>> {
	const { results } = await db
		.prepare(
			`SELECT * FROM repo_sessions
			WHERE user_id = ?
			ORDER BY updated_at DESC`,
		)
		.bind(userId)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapRepoSessionRow)
}

export async function listRepoSessionsForBranchCleanup(
	db: D1Database,
	input: {
		now: string
		abandonedBefore: string
		limit: number
	},
): Promise<Array<RepoSessionRow>> {
	const { results } = await db
		.prepare(
			`SELECT * FROM repo_sessions
			WHERE (status IN ('published', 'discarded') AND expires_at IS NOT NULL AND expires_at <= ?)
				OR (status = 'active' AND updated_at <= ?)
			ORDER BY updated_at ASC
			LIMIT ?`,
		)
		.bind(input.now, input.abandonedBefore, input.limit)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapRepoSessionRow)
}

export async function updateRepoSession(
	db: D1Database,
	input: {
		id: string
		userId: string
		sessionBranch?: string | null
		sourceBranch?: string
		baseCommit?: string
		sourceRoot?: string
		conversationId?: string | null
		status?: RepoSessionRow['status']
		expiresAt?: string | null
		lastCheckpointAt?: string | null
		lastCheckpointCommit?: string | null
		lastCheckRunId?: string | null
		lastCheckTreeHash?: string | null
	},
): Promise<boolean> {
	const assignments: Array<string> = []
	const values: Array<unknown> = []
	const add = (column: string, value: unknown) => {
		assignments.push(`${column} = ?`)
		values.push(value)
	}
	if (input.sessionBranch !== undefined) {
		add('session_branch', input.sessionBranch)
	}
	if (input.sourceBranch !== undefined) add('source_branch', input.sourceBranch)
	if (input.baseCommit !== undefined) add('base_commit', input.baseCommit)
	if (input.sourceRoot !== undefined) add('source_root', input.sourceRoot)
	if (input.conversationId !== undefined) {
		add('conversation_id', input.conversationId)
	}
	if (input.status !== undefined) add('status', input.status)
	if (input.expiresAt !== undefined) add('expires_at', input.expiresAt)
	if (input.lastCheckpointAt !== undefined) {
		add('last_checkpoint_at', input.lastCheckpointAt)
	}
	if (input.lastCheckpointCommit !== undefined) {
		add('last_checkpoint_commit', input.lastCheckpointCommit)
	}
	if (input.lastCheckRunId !== undefined) {
		add('last_check_run_id', input.lastCheckRunId)
	}
	if (input.lastCheckTreeHash !== undefined) {
		add('last_check_tree_hash', input.lastCheckTreeHash)
	}
	add('updated_at', new Date().toISOString())
	const result = await db
		.prepare(
			`UPDATE repo_sessions SET ${assignments.join(', ')}
			WHERE id = ? AND user_id = ?`,
		)
		.bind(...values, input.id, input.userId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function deleteRepoSession(
	db: D1Database,
	id: string,
): Promise<boolean> {
	const result = await db
		.prepare(`DELETE FROM repo_sessions WHERE id = ?`)
		.bind(id)
		.run()
	return (result.meta.changes ?? 0) > 0
}
