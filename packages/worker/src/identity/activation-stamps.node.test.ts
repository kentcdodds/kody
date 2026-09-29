import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	stampFirstExecute,
	stampFirstMcpConnected,
	stampFirstSavedPackage,
	stampFirstSearch,
} from './activation-stamps.ts'

test('activation stamps are write-once and keep the first client name', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const stableUserId = 'a'.repeat(64)
	sqlite
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			VALUES ('ada', 'ada@example.com', 'hash', ?)`,
		)
		.run(stableUserId)

	for (const day of ['27', '28']) {
		await stampFirstMcpConnected(db, {
			stableUserId,
			clientName: day === '27' ? 'claude-ai' : 'cursor',
			at: `2026-08-${day}T10:00:00.000Z`,
		})
		await stampFirstExecute(db, {
			stableUserId,
			at: `2026-08-${day}T11:00:00.000Z`,
		})
		await stampFirstSearch(db, {
			stableUserId,
			at: `2026-08-${day}T11:30:00.000Z`,
		})
		await stampFirstSavedPackage(db, {
			stableUserId,
			at: `2026-08-${day}T12:00:00.000Z`,
		})
	}

	expect(
		sqlite
			.prepare(
				`SELECT first_mcp_connected_at, mcp_client_name, first_execute_at,
					first_search_at, first_saved_package_at, first_secret_at,
					first_integration_at, first_job_at, last_active_at
				FROM users WHERE stable_user_id = ?`,
			)
			.get(stableUserId),
	).toEqual({
		first_mcp_connected_at: '2026-08-27T10:00:00.000Z',
		mcp_client_name: 'claude-ai',
		first_execute_at: '2026-08-27T11:00:00.000Z',
		first_search_at: '2026-08-27T11:30:00.000Z',
		first_saved_package_at: '2026-08-27T12:00:00.000Z',
		first_secret_at: null,
		first_integration_at: null,
		first_job_at: null,
		// last_active_at advances once per calendar day, not per stamp.
		last_active_at: '2026-08-28T10:00:00.000Z',
	})
})
