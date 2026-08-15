import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	listDueRepoSessionOwners,
	listRepoSessionDueOwnersPage,
	replaceRepoSessionDueOwner,
} from './repo-session-due-owners.ts'

test('due-owners upsert, page, and delete stay one row per user', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const now = new Date('2026-06-24T20:00:00.000Z')

	await replaceRepoSessionDueOwner({
		db,
		userId: 'user-b',
		dueAt: '2026-06-24T21:00:00.000Z',
		now,
	})
	await replaceRepoSessionDueOwner({
		db,
		userId: 'user-a',
		dueAt: '2026-06-24T19:00:00.000Z',
		now,
	})
	await replaceRepoSessionDueOwner({
		db,
		userId: 'user-a',
		dueAt: '2026-06-24T18:00:00.000Z',
		now,
	})

	expect(
		await listDueRepoSessionOwners({
			db,
			now,
			limit: 10,
		}),
	).toEqual([{ userId: 'user-a', dueAt: '2026-06-24T18:00:00.000Z' }])
	expect(await listRepoSessionDueOwnersPage({ db, limit: 10 })).toEqual([
		{ userId: 'user-a', dueAt: '2026-06-24T18:00:00.000Z' },
		{ userId: 'user-b', dueAt: '2026-06-24T21:00:00.000Z' },
	])

	await replaceRepoSessionDueOwner({
		db,
		userId: 'user-a',
		dueAt: null,
		now,
	})
	expect(await listRepoSessionDueOwnersPage({ db, limit: 10 })).toEqual([
		{ userId: 'user-b', dueAt: '2026-06-24T21:00:00.000Z' },
	])
})
