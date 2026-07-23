import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	AccountWriteLeaseLostError,
	listActiveAccountWriteLeases,
	markAccountDeleting,
	repairAccountWriteLease,
	withAccountWriteLease,
} from './account-deletion-state.ts'

test('non-expiring lease blocks deletion until audited repair fences callback', async () => {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE users (
			id INTEGER PRIMARY KEY,
			stable_user_id TEXT UNIQUE,
			deleting_at TEXT,
			active_write_count INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT
		);
		CREATE TABLE account_write_leases (
			token TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			holder TEXT NOT NULL,
			acquired_at TEXT NOT NULL,
			released_at TEXT
		);
		CREATE TABLE account_write_lease_repairs (
			id TEXT PRIMARY KEY,
			target_user_id TEXT NOT NULL,
			lease_token TEXT NOT NULL,
			lease_holder TEXT NOT NULL,
			lease_acquired_at TEXT NOT NULL,
			repaired_by_user_id TEXT NOT NULL,
			reason TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
		INSERT INTO users (id, stable_user_id) VALUES (1, 'user-a');
	`)
	const db = createD1FromSqlite(sqlite)
	let startWrite: () => void = () => undefined
	let finishWrite: () => void = () => undefined
	const started = new Promise<void>((resolve) => {
		startWrite = resolve
	})
	const finish = new Promise<void>((resolve) => {
		finishWrite = resolve
	})
	const operation = withAccountWriteLease({
		db,
		stableUserId: 'user-a',
		holder: 'test:crashed-writer',
		async write() {
			startWrite()
			await finish
			return 'terminal-commit'
		},
	})
	await started
	await expect(
		markAccountDeleting({
			db,
			dbUserId: 1,
			now: new Date('2099-01-01T00:00:00.000Z'),
		}),
	).resolves.toBe(1)
	const [lease] = await listActiveAccountWriteLeases(db, 'user-a')
	expect(lease).toEqual(
		expect.objectContaining({ holder: 'test:crashed-writer' }),
	)
	await repairAccountWriteLease({
		db,
		stableUserId: 'user-a',
		token: lease!.token,
		expectedAcquiredAt: lease!.acquired_at,
		repairedByUserId: 'admin-user',
		reason: 'Inspected worker crash and confirmed process termination.',
	})
	finishWrite()
	await expect(operation).rejects.toBeInstanceOf(AccountWriteLeaseLostError)
	await expect(markAccountDeleting({ db, dbUserId: 1 })).resolves.toBe(0)
	expect(
		sqlite.prepare(`SELECT reason FROM account_write_lease_repairs`).get(),
	).toEqual({
		reason: 'Inspected worker crash and confirmed process termination.',
	})
})
