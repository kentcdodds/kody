import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { isMissingRepoSessionsTable } from './repo-session-leftover-d1.ts'
import { repoSessionIndexRpc } from './repo-session-index-client.ts'

async function ensureRepoSessionIndexBackfillCursorSchema(
	db: D1Database,
): Promise<void> {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS repo_session_index_backfill_cursor (
				singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
				position TEXT NOT NULL DEFAULT '',
				updated_at TEXT NOT NULL
			)`,
		)
		.run()
	await db
		.prepare(
			`INSERT OR IGNORE INTO repo_session_index_backfill_cursor
			(singleton, position, updated_at)
			VALUES (1, '', ?)`,
		)
		.bind(new Date().toISOString())
		.run()
}

export const repoSessionIndexBackfillBatchSize = 25

export type RepoSessionIndexBackfillResult = {
	scanned: number
	imported: number
	remaining: number
	errors: number
}

async function readBackfillCursor(db: D1Database): Promise<string> {
	await ensureRepoSessionIndexBackfillCursorSchema(db)
	const row = await db
		.prepare(
			`SELECT position FROM repo_session_index_backfill_cursor
			WHERE singleton = 1`,
		)
		.first<{ position: string }>()
	return row?.position ?? ''
}

async function writeBackfillCursor(input: {
	db: D1Database
	afterUserId: string
	now: Date
}): Promise<void> {
	await ensureRepoSessionIndexBackfillCursorSchema(input.db)
	await input.db
		.prepare(
			`UPDATE repo_session_index_backfill_cursor
			SET position = ?, updated_at = ?
			WHERE singleton = 1`,
		)
		.bind(input.afterUserId, input.now.toISOString())
		.run()
}

async function listLeftoverD1Owners(input: {
	db: D1Database
	afterUserId: string
	limit: number
}): Promise<Array<string>> {
	try {
		const { results } = await input.db
			.prepare(
				`SELECT DISTINCT user_id
				FROM repo_sessions
				WHERE user_id > ?
				ORDER BY user_id ASC
				LIMIT ?`,
			)
			.bind(input.afterUserId, input.limit)
			.all<{ user_id: string }>()
		return (results ?? []).map((row) => row.user_id)
	} catch (error) {
		if (isMissingRepoSessionsTable(error)) return []
		throw error
	}
}

async function countLeftoverD1Rows(db: D1Database): Promise<number> {
	try {
		const row = await db
			.prepare(`SELECT COUNT(*) AS count FROM repo_sessions`)
			.first<{ count: number }>()
		return Number(row?.count ?? 0)
	} catch (error) {
		if (isMissingRepoSessionsTable(error)) return 0
		throw error
	}
}

/**
 * Fleet hydrate of leftover D1 `repo_sessions` into per-user RepoSessionIndex
 * objects. Idempotent INSERT OR IGNORE inside each index. Phase 2 DROP waits
 * until `remaining` stays 0.
 */
export async function backfillRepoSessionIndexes(input: {
	env: Env
	now?: Date
	batchSize?: number
}): Promise<RepoSessionIndexBackfillResult> {
	const now = input.now ?? new Date()
	const limit = input.batchSize ?? repoSessionIndexBackfillBatchSize
	const afterUserId = await readBackfillCursor(input.env.APP_DB)
	const owners = await listLeftoverD1Owners({
		db: input.env.APP_DB,
		afterUserId,
		limit,
	})
	let imported = 0
	let errors = 0
	let lastUserId = afterUserId
	for (const userId of owners) {
		try {
			const result = await repoSessionIndexRpc({
				env: input.env,
				userId,
			}).hydrateFromD1({ ownerId: userId })
			imported += result.imported
			lastUserId = userId
		} catch (error) {
			errors += 1
			console.warn(
				JSON.stringify({
					message: 'repo session index backfill failed',
					userId,
					error: getErrorMessage(error),
				}),
			)
			break
		}
	}
	const remaining = await countLeftoverD1Rows(input.env.APP_DB)
	if (owners.length === 0) {
		if (remaining > 0) {
			await writeBackfillCursor({
				db: input.env.APP_DB,
				afterUserId: '',
				now,
			})
		}
	} else if (lastUserId !== afterUserId) {
		await writeBackfillCursor({
			db: input.env.APP_DB,
			afterUserId: lastUserId,
			now,
		})
	}
	return {
		scanned: owners.length,
		imported,
		remaining,
		errors,
	}
}
