import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { listRepoSessionsForBranchCleanup } from './repo-sessions.ts'

function insertSession(
	sqlite: DatabaseSync,
	row: {
		id: string
		status: 'active' | 'published' | 'discarded'
		updatedAt: string
		lastCheckpointAt?: string | null
		expiresAt?: string | null
	},
) {
	sqlite
		.prepare(
			`INSERT INTO repo_sessions (
				id, user_id, source_id, source_repo_id, session_branch, source_branch,
				base_commit, source_root, conversation_id, status, expires_at,
				last_checkpoint_at, last_checkpoint_commit, last_check_run_id,
				last_check_tree_hash, created_at, updated_at
			) VALUES (?, 'user-1', 'source-1', 'repo-1', ?, 'main', 'commit', '/',
				NULL, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
		)
		.run(
			row.id,
			`sessions/${row.id}`,
			row.status,
			row.expiresAt ?? null,
			row.lastCheckpointAt ?? null,
			row.updatedAt,
			row.updatedAt,
		)
}

test('branch cleanup selects unused leftovers sooner than edited sessions', async () => {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE repo_sessions (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			source_id TEXT NOT NULL,
			source_repo_id TEXT NOT NULL,
			session_branch TEXT NOT NULL,
			source_branch TEXT NOT NULL,
			base_commit TEXT NOT NULL,
			source_root TEXT NOT NULL DEFAULT '/',
			conversation_id TEXT,
			status TEXT NOT NULL DEFAULT 'active',
			expires_at TEXT,
			last_checkpoint_at TEXT,
			last_checkpoint_commit TEXT,
			last_check_run_id TEXT,
			last_check_tree_hash TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
	`)
	insertSession(sqlite, {
		id: 'unused-stale',
		status: 'active',
		updatedAt: '2026-06-24T19:00:00.000Z',
	})
	insertSession(sqlite, {
		id: 'unused-fresh',
		status: 'active',
		updatedAt: '2026-06-24T19:45:00.000Z',
	})
	insertSession(sqlite, {
		id: 'edited-recent',
		status: 'active',
		updatedAt: '2026-06-20T20:00:00.000Z',
		lastCheckpointAt: '2026-06-20T20:00:00.000Z',
	})
	insertSession(sqlite, {
		id: 'edited-stale',
		status: 'active',
		updatedAt: '2026-06-16T20:00:00.000Z',
		lastCheckpointAt: '2026-06-16T20:00:00.000Z',
	})
	insertSession(sqlite, {
		id: 'published-expired',
		status: 'published',
		updatedAt: '2026-06-24T10:00:00.000Z',
		lastCheckpointAt: '2026-06-24T10:00:00.000Z',
		expiresAt: '2026-06-24T12:00:00.000Z',
	})
	insertSession(sqlite, {
		id: 'published-live',
		status: 'published',
		updatedAt: '2026-06-24T10:00:00.000Z',
		lastCheckpointAt: '2026-06-24T10:00:00.000Z',
		expiresAt: '2026-06-25T12:00:00.000Z',
	})

	const selected = await listRepoSessionsForBranchCleanup(
		createD1FromSqlite(sqlite),
		{
			now: '2026-06-24T20:00:00.000Z',
			unusedAbandonedBefore: '2026-06-24T19:30:00.000Z',
			editedAbandonedBefore: '2026-06-17T20:00:00.000Z',
			limit: 10,
		},
	)

	expect(selected.map((session) => session.id)).toEqual([
		'edited-stale',
		'published-expired',
		'unused-stale',
	])
})
