import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { insertEntitySource } from './entity-sources.ts'
import { insertUserRepo, listUserRepos } from './user-repos.ts'

test('listUserRepos joins entity_sources without ambiguous columns and prefers indexed_commit', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const now = '2026-09-14T00:00:00.000Z'

	await insertUserRepo(db, {
		id: 'repo-indexed',
		user_id: 'user-1',
		name: 'indexed-notes',
		description: 'has both commits',
		created_at: now,
		updated_at: now,
	})
	await insertEntitySource(db, {
		id: 'source-indexed',
		user_id: 'user-1',
		entity_kind: 'repo',
		entity_id: 'repo-indexed',
		repo_id: 'repo-indexed',
		published_commit: 'pub-old',
		indexed_commit: 'idx-new',
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: now,
		updated_at: now,
	})

	await insertUserRepo(db, {
		id: 'repo-published',
		user_id: 'user-1',
		name: 'published-notes',
		description: null,
		created_at: now,
		updated_at: now,
	})
	await insertEntitySource(db, {
		id: 'source-published',
		user_id: 'user-1',
		entity_kind: 'repo',
		entity_id: 'repo-published',
		repo_id: 'repo-published',
		published_commit: 'pub-only',
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: now,
		updated_at: now,
	})

	await insertUserRepo(db, {
		id: 'repo-empty',
		user_id: 'user-1',
		name: 'empty-notes',
		description: null,
		created_at: now,
		updated_at: now,
	})

	await insertUserRepo(db, {
		id: 'repo-other',
		user_id: 'user-2',
		name: 'other-notes',
		description: null,
		created_at: now,
		updated_at: now,
	})

	const repos = await listUserRepos(db, 'user-1')
	expect(repos.map((repo) => [repo.id, repo.name, repo.iconCommit])).toEqual([
		['repo-empty', 'empty-notes', null],
		['repo-indexed', 'indexed-notes', 'idx-new'],
		['repo-published', 'published-notes', 'pub-only'],
	])
	expect(repos.every((repo) => repo.userId === 'user-1')).toBe(true)
})
