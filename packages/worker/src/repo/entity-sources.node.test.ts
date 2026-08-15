import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	deleteEntitySource,
	externalReconcileGraceMs,
	listEntitySourcesForExternalReconcile,
	markEntitySourcePendingExternalReconcile,
} from './entity-sources.ts'

test('source deletion removes only its repo-session storage inventory', async () => {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE entity_sources (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL
		);
		CREATE TABLE repo_sessions (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			source_id TEXT NOT NULL
		);
		CREATE TABLE user_storage_buckets (
			user_id TEXT NOT NULL,
			storage_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			PRIMARY KEY (user_id, storage_id)
		);
		INSERT INTO entity_sources VALUES
			('source-a', 'user-a'),
			('source-b', 'user-b');
		INSERT INTO repo_sessions VALUES
			('session-a', 'user-a', 'source-a'),
			('session-b', 'user-b', 'source-b');
		INSERT INTO user_storage_buckets VALUES
			('user-a', 'repo-session:session-a', 'repo_session'),
			('user-a', 'exec:keep', 'execute'),
			('user-b', 'repo-session:session-b', 'repo_session');
	`)
	const db = createD1FromSqlite(sqlite)

	await expect(
		deleteEntitySource({ APP_DB: db }, { id: 'source-a', userId: 'user-a' }),
	).resolves.toBe(true)
	expect(
		sqlite
			.prepare(
				`SELECT user_id, storage_id, kind
				FROM user_storage_buckets
				ORDER BY user_id, storage_id`,
			)
			.all(),
	).toEqual([
		{ user_id: 'user-a', storage_id: 'exec:keep', kind: 'execute' },
		{
			user_id: 'user-b',
			storage_id: 'repo-session:session-b',
			kind: 'repo_session',
		},
	])
	expect(
		sqlite.prepare(`SELECT id FROM repo_sessions ORDER BY id`).all(),
	).toEqual([{ id: 'session-b' }])
})

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
