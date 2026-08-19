import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { upsertValueBucket, upsertValueEntry } from '#mcp/values/repo.ts'
import {
	formatActiveRetiringPrimitivesInstructions,
	loadActiveRetiringNoticeIds,
} from './retiring-primitives.ts'

function createValuesDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE value_buckets (
			id TEXT PRIMARY KEY NOT NULL,
			user_id TEXT NOT NULL,
			scope TEXT NOT NULL,
			binding_key TEXT NOT NULL,
			expires_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			UNIQUE(user_id, scope, binding_key)
		);
		CREATE TABLE value_entries (
			bucket_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			value TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (bucket_id, name)
		);
	`)
	return createD1FromSqlite(sqlite)
}

test('loadActiveRetiringNoticeIds is true only for users with a live stored value', async () => {
	const db = createValuesDb()
	await upsertValueBucket({
		db,
		row: {
			id: 'empty-bucket',
			user_id: 'user-empty',
			scope: 'user',
			binding_key: 'global',
			expires_at: null,
		},
	})
	await upsertValueBucket({
		db,
		row: {
			id: 'expired-bucket',
			user_id: 'user-expired',
			scope: 'session',
			binding_key: 'session-1',
			expires_at: '2020-01-01T00:00:00.000Z',
		},
	})
	await upsertValueEntry({
		db,
		row: {
			bucket_id: 'expired-bucket',
			name: 'stale',
			description: '',
			value: 'gone',
		},
	})
	await upsertValueBucket({
		db,
		row: {
			id: 'live-bucket',
			user_id: 'user-live',
			scope: 'user',
			binding_key: 'global',
			expires_at: null,
		},
	})
	await upsertValueEntry({
		db,
		row: {
			bucket_id: 'live-bucket',
			name: 'timezone',
			description: '',
			value: 'America/Denver',
		},
	})

	await expect(loadActiveRetiringNoticeIds(db, null)).resolves.toEqual(
		new Set(),
	)
	await expect(loadActiveRetiringNoticeIds(db, '')).resolves.toEqual(new Set())
	await expect(loadActiveRetiringNoticeIds(db, 'user-empty')).resolves.toEqual(
		new Set(),
	)
	await expect(
		loadActiveRetiringNoticeIds(db, 'user-expired'),
	).resolves.toEqual(new Set())
	await expect(loadActiveRetiringNoticeIds(db, 'user-other')).resolves.toEqual(
		new Set(),
	)
	const live = await loadActiveRetiringNoticeIds(db, 'user-live')
	expect(live).toEqual(new Set(['values']))
	expect(formatActiveRetiringPrimitivesInstructions(live)).toContain(
		'coding_guide_get({ guide: "values" })',
	)
	expect(formatActiveRetiringPrimitivesInstructions(new Set())).toBe('')
})
