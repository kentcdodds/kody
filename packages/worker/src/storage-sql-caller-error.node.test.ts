import { expect, test } from 'vitest'
import { isUserStorageSqlCallerMessage } from './storage-sql-caller-error.ts'

test('isUserStorageSqlCallerMessage matches Durable Object SQL caller mistakes', () => {
	expect(
		isUserStorageSqlCallerMessage('no such table: articles: SQLITE_ERROR'),
	).toBe(true)
	expect(
		isUserStorageSqlCallerMessage('no such column: title: SQLITE_ERROR'),
	).toBe(true)
	expect(
		isUserStorageSqlCallerMessage(
			'UNIQUE constraint failed: notes.id: SQLITE_CONSTRAINT',
		),
	).toBe(true)
	expect(
		isUserStorageSqlCallerMessage('storage.sql requires a non-empty query.'),
	).toBe(true)
	expect(
		isUserStorageSqlCallerMessage(
			'storage.sql params only support strings, numbers, booleans, and null.',
		),
	).toBe(true)
	expect(
		isUserStorageSqlCallerMessage(
			'Read-only storage.sql only allows a single SELECT, EXPLAIN, or schema PRAGMA statement. Pass writable: true to allow multi-statement or mutating queries.',
		),
	).toBe(true)
})

test('isUserStorageSqlCallerMessage leaves platform lock and unrelated errors alone', () => {
	expect(
		isUserStorageSqlCallerMessage(
			'D1_ERROR: NOSENTRY database is locked: SQLITE_BUSY',
		),
	).toBe(false)
	expect(
		isUserStorageSqlCallerMessage('database is locked: SQLITE_LOCKED'),
	).toBe(false)
	expect(isUserStorageSqlCallerMessage('platform handler blew up')).toBe(false)
	expect(isUserStorageSqlCallerMessage('no such table: users')).toBe(false)
})
