import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	externalReconcileGraceMs,
	listEntitySourcesForExternalReconcile,
	markEntitySourcePendingExternalReconcile,
} from './entity-sources.ts'

test('external reconcile selects token-pending packages and the daily backstop covers the fleet', async () => {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE entity_sources (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			entity_kind TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			repo_id TEXT NOT NULL,
			published_commit TEXT,
			indexed_commit TEXT,
			manifest_path TEXT NOT NULL,
			source_root TEXT NOT NULL,
			last_external_check_at TEXT,
			external_check_until TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		INSERT INTO entity_sources VALUES
			(
				'dormant', 'user-1', 'package', 'package-1', 'repo-1',
				'commit-1', NULL, 'package.json', '/', NULL, NULL,
				'2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'
			),
			(
				'pending', 'user-2', 'package', 'package-2', 'repo-2',
				'commit-2', NULL, 'package.json', '/',
				'2026-05-04T01:00:00.000Z', '2026-05-04T04:00:00.000Z',
				'2026-05-02T00:00:00.000Z', '2026-05-02T00:00:00.000Z'
			),
			(
				'job', 'user-1', 'job', 'job-1', 'repo-3',
				'commit-3', NULL, 'kody.json', '/', NULL,
				'2026-05-04T04:00:00.000Z',
				'2026-05-03T00:00:00.000Z', '2026-05-03T00:00:00.000Z'
			);
	`)
	const db = createD1FromSqlite(sqlite)
	const before = '2026-05-04T01:55:00.000Z'

	const initial = await listEntitySourcesForExternalReconcile(db, {
		before,
		limit: 50,
	})
	expect(initial.map((row) => row.id)).toEqual(['pending'])

	const tokenExpiresAt = '2026-05-04T03:00:00.000Z'
	await markEntitySourcePendingExternalReconcile(db, {
		id: 'dormant',
		userId: 'user-1',
		tokenExpiresAt,
	})
	const marked = sqlite
		.prepare(
			`SELECT external_check_until
			FROM entity_sources
			WHERE id = 'dormant' AND user_id = 'user-1'`,
		)
		.get() as { external_check_until: string }
	expect(marked.external_check_until).toBe(
		new Date(
			new Date(tokenExpiresAt).getTime() + externalReconcileGraceMs,
		).toISOString(),
	)

	const afterMint = await listEntitySourcesForExternalReconcile(db, {
		before,
		limit: 50,
	})
	expect(afterMint.map((row) => row.id)).toEqual(['dormant', 'pending'])

	const dailyBackstop = await listEntitySourcesForExternalReconcile(db, {
		before,
		limit: 50,
		includeAll: true,
	})
	expect(dailyBackstop.map((row) => row.id)).toEqual(['dormant', 'pending'])
})
