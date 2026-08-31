import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { listMemoriesByUserIdPage } from './repo.ts'

function createMemoryDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE mcp_memories (
			id TEXT PRIMARY KEY NOT NULL,
			user_id TEXT NOT NULL,
			category TEXT,
			status TEXT NOT NULL DEFAULT 'active',
			subject TEXT NOT NULL,
			summary TEXT NOT NULL,
			details TEXT NOT NULL DEFAULT '',
			tags_json TEXT NOT NULL DEFAULT '[]',
			source_uris_json TEXT NOT NULL DEFAULT '[]',
			dedupe_key TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			last_accessed_at TEXT,
			deleted_at TEXT
		)
	`)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function insertMemory(
	sqlite: DatabaseSync,
	row: { id: string; userId: string; status: string; subject: string },
) {
	sqlite
		.prepare(
			`INSERT INTO mcp_memories (
				id, user_id, status, subject, summary, details, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		)
		.run(row.id, row.userId, row.status, row.subject, row.subject)
}

test('listMemoriesByUserIdPage is user-scoped, status-filtered, and keyset-paged', async () => {
	const { sqlite, db } = createMemoryDb()
	insertMemory(sqlite, {
		id: 'mem-a',
		userId: 'user-1',
		status: 'active',
		subject: 'Owned active',
	})
	insertMemory(sqlite, {
		id: 'mem-b',
		userId: 'user-1',
		status: 'deleted',
		subject: 'Owned deleted',
	})
	insertMemory(sqlite, {
		id: 'mem-c',
		userId: 'user-1',
		status: 'archived',
		subject: 'Owned archived',
	})
	insertMemory(sqlite, {
		id: 'mem-other',
		userId: 'user-2',
		status: 'active',
		subject: 'Foreign active',
	})

	const firstPage = await listMemoriesByUserIdPage({
		db,
		userId: 'user-1',
		afterId: null,
		limit: 2,
		statuses: ['active', 'archived'],
	})
	expect(firstPage.map((row) => row.id)).toEqual(['mem-a', 'mem-c'])
	expect(firstPage.every((row) => row.user_id === 'user-1')).toBe(true)

	const secondPage = await listMemoriesByUserIdPage({
		db,
		userId: 'user-1',
		afterId: firstPage.at(-1)?.id ?? null,
		limit: 2,
		statuses: ['active', 'archived'],
	})
	expect(secondPage).toEqual([])

	const withDeleted = await listMemoriesByUserIdPage({
		db,
		userId: 'user-1',
		afterId: null,
		limit: 10,
		statuses: ['active', 'archived', 'deleted'],
	})
	expect(withDeleted.map((row) => row.id)).toEqual(['mem-a', 'mem-b', 'mem-c'])
	expect(withDeleted.some((row) => row.user_id !== 'user-1')).toBe(false)
})
