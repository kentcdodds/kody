import { repoSessionRowSchema, type RepoSessionRow } from './types.ts'

function mapRepoSessionRow(row: Record<string, unknown>): RepoSessionRow {
	return repoSessionRowSchema.parse({
		id: String(row['id']),
		user_id: String(row['user_id']),
		source_id: String(row['source_id']),
		session_repo_id: String(row['session_repo_id']),
		session_repo_name: String(row['session_repo_name']),
		session_repo_namespace: String(row['session_repo_namespace']),
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
				id, user_id, source_id, session_repo_id, session_repo_name, session_repo_namespace,
				base_commit, source_root, conversation_id, status, expires_at,
				last_checkpoint_at, last_checkpoint_commit, last_check_run_id,
				last_check_tree_hash, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.user_id,
			row.source_id,
			row.session_repo_id,
			row.session_repo_name,
			row.session_repo_namespace,
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

export async function updateRepoSession(
	db: D1Database,
	input: {
		id: string
		userId: string
		sessionRepoId?: string
		sessionRepoName?: string
		sessionRepoNamespace?: string
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
	if (input.sessionRepoId !== undefined) {
		add('session_repo_id', input.sessionRepoId)
	}
	if (input.sessionRepoName !== undefined) {
		add('session_repo_name', input.sessionRepoName)
	}
	if (input.sessionRepoNamespace !== undefined) {
		add('session_repo_namespace', input.sessionRepoNamespace)
	}
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
