import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	AccountWriteLeaseLostError,
	listActiveAccountWriteLeases,
	markAccountDeleting,
	repairAccountWriteLease,
	withAccountWriteLease,
} from './deletion-state.ts'

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

function createLeaseTestDb() {
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
		INSERT INTO users (id, stable_user_id) VALUES (1, 'user-a');
		INSERT INTO users (id, stable_user_id) VALUES (2, 'user-b');
	`)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function countLeaseRows(sqlite: DatabaseSync) {
	const row = sqlite
		.prepare(`SELECT COUNT(*) AS count FROM account_write_leases`)
		.get() as { count: number }
	return Number(row.count)
}

test('nested same-user lease reuses the outer lease instead of re-acquiring', async () => {
	const { sqlite, db } = createLeaseTestDb()
	const result = await withAccountWriteLease({
		db,
		stableUserId: 'user-a',
		holder: 'test:outer',
		async write() {
			expect(countLeaseRows(sqlite)).toBe(1)
			return await withAccountWriteLease({
				db,
				stableUserId: 'user-a',
				holder: 'test:nested',
				async write() {
					// Still only the outer lease: the nested call must not pay
					// another acquire/release round trip.
					expect(countLeaseRows(sqlite)).toBe(1)
					const active = await listActiveAccountWriteLeases(db, 'user-a')
					expect(active).toHaveLength(1)
					expect(active[0]).toEqual(
						expect.objectContaining({ holder: 'test:outer' }),
					)
					return 'nested-result'
				},
			})
		},
	})
	expect(result).toBe('nested-result')
	// The outer release is the only release.
	expect(await listActiveAccountWriteLeases(db, 'user-a')).toHaveLength(0)
	expect(
		sqlite.prepare(`SELECT active_write_count FROM users WHERE id = 1`).get(),
	).toEqual({ active_write_count: 0 })
})

test('nested lease for a different user still acquires its own lease', async () => {
	const { sqlite, db } = createLeaseTestDb()
	await withAccountWriteLease({
		db,
		stableUserId: 'user-a',
		holder: 'test:outer',
		async write() {
			await withAccountWriteLease({
				db,
				stableUserId: 'user-b',
				holder: 'test:other-user',
				async write() {
					expect(countLeaseRows(sqlite)).toBe(2)
					expect(await listActiveAccountWriteLeases(db, 'user-b')).toHaveLength(
						1,
					)
				},
			})
		},
	})
	expect(await listActiveAccountWriteLeases(db, 'user-a')).toHaveLength(0)
	expect(await listActiveAccountWriteLeases(db, 'user-b')).toHaveLength(0)
})

test('detached work spawned inside write re-acquires after the outer lease releases', async () => {
	const { sqlite, db } = createLeaseTestDb()
	let detached: Promise<void> = Promise.resolve()
	let releaseOuter: () => void = () => undefined
	const outerReleased = new Promise<void>((resolve) => {
		releaseOuter = resolve
	})
	await withAccountWriteLease({
		db,
		stableUserId: 'user-a',
		holder: 'test:outer',
		async write() {
			// Simulates a waitUntil callback: created inside the lease scope
			// (inheriting the AsyncLocalStorage context) but running only
			// after the outer lease has been released.
			detached = (async () => {
				await outerReleased
				await withAccountWriteLease({
					db,
					stableUserId: 'user-a',
					holder: 'test:detached',
					async write() {
						const active = await listActiveAccountWriteLeases(db, 'user-a')
						expect(active).toHaveLength(1)
						expect(active[0]).toEqual(
							expect.objectContaining({ holder: 'test:detached' }),
						)
					},
				})
			})()
		},
	})
	releaseOuter()
	await detached
	expect(countLeaseRows(sqlite)).toBe(2)
	expect(await listActiveAccountWriteLeases(db, 'user-a')).toHaveLength(0)
	expect(
		sqlite.prepare(`SELECT active_write_count FROM users WHERE id = 1`).get(),
	).toEqual({ active_write_count: 0 })
})

test('sequential sibling leases each acquire after the previous released', async () => {
	const { sqlite, db } = createLeaseTestDb()
	await withAccountWriteLease({
		db,
		stableUserId: 'user-a',
		async write() {
			expect(countLeaseRows(sqlite)).toBe(1)
		},
	})
	await withAccountWriteLease({
		db,
		stableUserId: 'user-a',
		async write() {
			expect(countLeaseRows(sqlite)).toBe(2)
			expect(await listActiveAccountWriteLeases(db, 'user-a')).toHaveLength(1)
		},
	})
	expect(await listActiveAccountWriteLeases(db, 'user-a')).toHaveLength(0)
})
