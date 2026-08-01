import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	userMeterRpc,
	type UserMeterEnv,
} from '#worker/entitlements/user-meter-client.ts'
import { silenceExpectedConsoleWarns } from '#worker/test-support/console-spies.ts'
import {
	createInMemoryUserMeterEnv,
	createWaitUntilDrain,
} from '#worker/test-support/user-meter.ts'
import {
	AccountDeletionInProgressError,
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

function addLeaseRepairsTable(sqlite: DatabaseSync) {
	sqlite.exec(`
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
	`)
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
	expect(countLeaseRows(sqlite)).toBe(0)
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
			expect(countLeaseRows(sqlite)).toBe(1)
			expect(await listActiveAccountWriteLeases(db, 'user-a')).toHaveLength(1)
		},
	})
	expect(await listActiveAccountWriteLeases(db, 'user-a')).toHaveLength(0)
	expect(countLeaseRows(sqlite)).toBe(0)
})

test('waitUntil moves lease release off the response path', async () => {
	let finishRelease: () => void = () => undefined
	const releaseGate = new Promise<void>((resolve) => {
		finishRelease = resolve
	})
	let updateCount = 0
	const db = {
		prepare() {
			return {
				bind() {
					return {
						async run() {
							updateCount++
							if (updateCount === 1) {
								return { meta: { changes: 1 } }
							}
							await releaseGate
							return { meta: { changes: 1 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database
	let releasePromise: Promise<unknown> | undefined

	const result = await withAccountWriteLease({
		db,
		stableUserId: 'user-a',
		waitUntil(promise) {
			releasePromise = promise
		},
		async write() {
			return 'response'
		},
	})

	expect(result).toBe('response')
	expect(updateCount).toBe(2)
	expect(releasePromise).toBeDefined()
	finishRelease()
	await releasePromise
})

test('optional env shadows mark/acquire/release/repair into UserMeter without changing D1 authority', async () => {
	const { sqlite, db } = createLeaseTestDb()
	addLeaseRepairsTable(sqlite)
	const meter = createInMemoryUserMeterEnv()
	const drain = createWaitUntilDrain()
	const meterA = userMeterRpc({ env: meter.env, userId: 'user-a' })
	const meterB = userMeterRpc({ env: meter.env, userId: 'user-b' })

	await withAccountWriteLease({
		db,
		stableUserId: 'user-a',
		holder: 'test:shadowed',
		env: meter.env,
		waitUntil: drain.waitUntil,
		async write() {
			expect(await listActiveAccountWriteLeases(db, 'user-a')).toHaveLength(1)
			return 'ok'
		},
	})
	await drain.drain()
	expect(await listActiveAccountWriteLeases(db, 'user-a')).toHaveLength(0)
	expect(await meterA.countActiveWriteLeases()).toEqual({ count: 0 })

	let heldToken = ''
	let heldAcquiredAt = ''
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
		holder: 'test:repair-shadow',
		env: meter.env,
		waitUntil: drain.waitUntil,
		async write() {
			const [lease] = await listActiveAccountWriteLeases(db, 'user-a')
			heldToken = lease!.token
			heldAcquiredAt = lease!.acquired_at
			startWrite()
			await finish
			return 'lost'
		},
	})
	await started
	await drain.drain()
	expect(await meterA.countActiveWriteLeases()).toEqual({ count: 1 })

	await expect(
		markAccountDeleting({
			db,
			dbUserId: 1,
			now: new Date('2099-01-01T00:00:00.000Z'),
			env: meter.env,
			waitUntil: drain.waitUntil,
		}),
	).resolves.toBe(1)
	await drain.drain()
	expect(await meterA.readDeletionState()).toEqual({
		deletingAt: '2099-01-01 00:00:00',
	})

	await repairAccountWriteLease({
		db,
		stableUserId: 'user-a',
		token: heldToken,
		expectedAcquiredAt: heldAcquiredAt,
		repairedByUserId: 'admin-user',
		reason: 'Inspected worker crash and confirmed process termination.',
		env: meter.env,
		waitUntil: drain.waitUntil,
	})
	await drain.drain()
	finishWrite()
	await expect(operation).rejects.toBeInstanceOf(AccountWriteLeaseLostError)
	expect(await meterA.countActiveWriteLeases()).toEqual({ count: 0 })

	await expect(
		withAccountWriteLease({
			db,
			stableUserId: 'user-a',
			env: meter.env,
			async write() {
				return 'blocked'
			},
		}),
	).rejects.toBeInstanceOf(AccountDeletionInProgressError)
	await withAccountWriteLease({
		db,
		stableUserId: 'user-b',
		holder: 'test:other-user',
		env: meter.env,
		waitUntil: drain.waitUntil,
		async write() {
			return 'ok'
		},
	})
	await drain.drain()
	expect(await meterB.readDeletionState()).toEqual({ deletingAt: null })
})

function createFailingShadowEnv(): UserMeterEnv {
	return {
		USER_METER: {
			idFromName: (name: string) => ({ name, toString: () => name }),
			get: () => ({
				async shadowMarkDeleting() {
					throw new Error('shadow mark failed')
				},
				async shadowReplaceDeletionState() {
					throw new Error('shadow replace failed')
				},
				async shadowAcquireWriteLease() {
					throw new Error('shadow acquire failed')
				},
				async shadowReleaseWriteLease() {
					throw new Error('shadow release failed')
				},
			}),
		},
	} as unknown as UserMeterEnv
}

test('UserMeter shadow failures never alter D1 lease or deletion results', async () => {
	silenceExpectedConsoleWarns(['account-deletion-user-meter-shadow-failed'])
	const { db } = createLeaseTestDb()
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	const failingEnv = createFailingShadowEnv()

	let finishRelease: () => void = () => undefined
	const releaseGate = new Promise<void>((resolve) => {
		finishRelease = resolve
	})
	const originalBatch = db.batch.bind(db)
	let releaseBatchSeen = false
	db.batch = (async (statements: Parameters<D1Database['batch']>[0]) => {
		const sql = statements
			.map((statement) => {
				const withQuery = statement as { query?: string }
				return typeof withQuery.query === 'string' ? withQuery.query : ''
			})
			.join('\n')
		const isRelease =
			sql.includes('MAX(active_write_count - 1') ||
			sql.includes('DELETE FROM account_write_leases')
		if (isRelease && !releaseBatchSeen) {
			releaseBatchSeen = true
			await releaseGate
		}
		return await originalBatch(statements)
	}) as D1Database['batch']

	const pending: Array<Promise<unknown>> = []
	await expect(
		withAccountWriteLease({
			db,
			stableUserId: 'user-a',
			holder: 'test:shadow-fail',
			env: failingEnv,
			waitUntil(promise) {
				pending.push(promise)
			},
			async write() {
				return 'mutated'
			},
		}),
	).resolves.toBe('mutated')
	expect(pending.length).toBeGreaterThan(0)
	expect(await listActiveAccountWriteLeases(db, 'user-a')).toHaveLength(1)
	finishRelease()
	await Promise.all(pending)
	expect(await listActiveAccountWriteLeases(db, 'user-a')).toHaveLength(0)

	await expect(
		markAccountDeleting({
			db,
			dbUserId: 1,
			env: failingEnv,
		}),
	).resolves.toBe(0)
	expect(warn).toHaveBeenCalledWith(
		'account-deletion-user-meter-shadow-failed',
		expect.any(Error),
	)
	warn.mockRestore()
})

function createDeferred() {
	let resolve: () => void = () => undefined
	const promise = new Promise<void>((next) => {
		resolve = next
	})
	return { promise, resolve: () => resolve() }
}

function createGatedShadowEnv(input: {
	releaseGate: Promise<void>
	markGate?: Promise<void>
}) {
	const base = createInMemoryUserMeterEnv()
	const namespace = base.env.USER_METER!
	const gates = {
		markEntered: false,
		releaseEntered: false,
	}
	const env = {
		USER_METER: {
			idFromName: namespace.idFromName.bind(namespace),
			get(id: DurableObjectId) {
				const stub = namespace.get(id)
				return {
					shadowMarkDeleting: (args: { deletingAt: string }) =>
						stub.shadowMarkDeleting(args),
					shadowReplaceDeletionState: async (args: {
						deletingAt: string
						leases?: ReadonlyArray<{
							token: string
							holder: string
							acquiredAt: string
						}>
					}) => {
						gates.markEntered = true
						if (input.markGate) await input.markGate
						return stub.shadowReplaceDeletionState(args)
					},
					shadowAcquireWriteLease: (args: {
						token: string
						holder: string
						acquiredAt: string
					}) => stub.shadowAcquireWriteLease(args),
					shadowReleaseWriteLease: async (args: { token: string }) => {
						gates.releaseEntered = true
						await input.releaseGate
						return stub.shadowReleaseWriteLease(args)
					},
					countActiveWriteLeases: () => stub.countActiveWriteLeases(),
					readDeletionState: () => stub.readDeletionState(),
					listWriteLeases: (
						args: { pageSize?: number; startAfter?: string | null } = {},
					) => stub.listWriteLeases(args),
				}
			},
		},
	} as unknown as UserMeterEnv
	return {
		env,
		gates,
		meterFor(userId: string) {
			return userMeterRpc({ env, userId })
		},
	}
}

async function waitFor(predicate: () => Promise<boolean>, label: string) {
	const deadline = Date.now() + 2_000
	while (Date.now() < deadline) {
		if (await predicate()) return
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
	throw new Error(`Timed out waiting for ${label}`)
}

test('without waitUntil, lease return awaits release shadow', async () => {
	const { db } = createLeaseTestDb()
	const release = createDeferred()
	const gated = createGatedShadowEnv({ releaseGate: release.promise })
	const meterA = gated.meterFor('user-a')

	let settled = false
	const operation = withAccountWriteLease({
		db,
		stableUserId: 'user-a',
		holder: 'test:await-release-shadow',
		env: gated.env,
		async write() {
			return 'ok'
		},
	}).then((value) => {
		settled = true
		return value
	})
	await waitFor(
		async () =>
			gated.gates.releaseEntered &&
			(await listActiveAccountWriteLeases(db, 'user-a')).length === 0 &&
			(await meterA.countActiveWriteLeases()).count === 1,
		'D1 release with gated shadow lease still held',
	)
	expect(settled).toBe(false)
	release.resolve()
	await expect(operation).resolves.toBe('ok')
	expect(await meterA.countActiveWriteLeases()).toEqual({ count: 0 })
})

test('without waitUntil, mark and repair await their shadows', async () => {
	const { sqlite, db } = createLeaseTestDb()
	addLeaseRepairsTable(sqlite)
	const release = createDeferred()
	const mark = createDeferred()
	const gated = createGatedShadowEnv({
		releaseGate: release.promise,
		markGate: mark.promise,
	})
	const meterA = gated.meterFor('user-a')
	const drain = createWaitUntilDrain()

	let heldToken = ''
	let heldAcquiredAt = ''
	let startWrite: () => void = () => undefined
	let finishWrite: () => void = () => undefined
	const started = new Promise<void>((resolve) => {
		startWrite = resolve
	})
	const finish = new Promise<void>((resolve) => {
		finishWrite = resolve
	})
	const held = withAccountWriteLease({
		db,
		stableUserId: 'user-a',
		holder: 'test:await-mark-repair',
		env: gated.env,
		waitUntil: drain.waitUntil,
		async write() {
			const [lease] = await listActiveAccountWriteLeases(db, 'user-a')
			heldToken = lease!.token
			heldAcquiredAt = lease!.acquired_at
			startWrite()
			await finish
			return 'lost'
		},
	})
	await started
	await drain.drain()

	let markSettled = false
	const markPromise = markAccountDeleting({
		db,
		dbUserId: 1,
		now: new Date('2099-01-01T00:00:00.000Z'),
		env: gated.env,
	}).then((count) => {
		markSettled = true
		return count
	})
	await waitFor(
		async () => gated.gates.markEntered && !markSettled,
		'mark shadow gate',
	)
	expect(await meterA.readDeletionState()).toEqual({ deletingAt: null })
	mark.resolve()
	await expect(markPromise).resolves.toBe(1)
	expect(await meterA.readDeletionState()).toEqual({
		deletingAt: '2099-01-01 00:00:00',
	})

	let repairSettled = false
	const repairPromise = repairAccountWriteLease({
		db,
		stableUserId: 'user-a',
		token: heldToken,
		expectedAcquiredAt: heldAcquiredAt,
		repairedByUserId: 'admin-user',
		reason: 'Inspected worker crash and confirmed process termination.',
		env: gated.env,
	}).then((result) => {
		repairSettled = true
		return result
	})
	await waitFor(
		async () =>
			gated.gates.releaseEntered &&
			(await meterA.countActiveWriteLeases()).count === 1 &&
			!repairSettled,
		'repair shadow gate',
	)
	release.resolve()
	await expect(repairPromise).resolves.toEqual(
		expect.objectContaining({ repaired: true }),
	)
	expect(await meterA.countActiveWriteLeases()).toEqual({ count: 0 })
	finishWrite()
	await expect(held).rejects.toBeInstanceOf(AccountWriteLeaseLostError)
	await drain.drain()
})

test('with waitUntil, lease return completes before release shadow settles', async () => {
	const { db } = createLeaseTestDb()
	const release = createDeferred()
	const gated = createGatedShadowEnv({ releaseGate: release.promise })
	const meterA = gated.meterFor('user-a')
	const drain = createWaitUntilDrain()

	await expect(
		withAccountWriteLease({
			db,
			stableUserId: 'user-a',
			holder: 'test:detach-release-shadow',
			env: gated.env,
			waitUntil: drain.waitUntil,
			async write() {
				return 'ok'
			},
		}),
	).resolves.toBe('ok')
	await waitFor(
		async () =>
			gated.gates.releaseEntered &&
			(await listActiveAccountWriteLeases(db, 'user-a')).length === 0 &&
			(await meterA.countActiveWriteLeases()).count === 1,
		'detached release shadow still held',
	)

	release.resolve()
	await drain.drain()
	expect(await meterA.countActiveWriteLeases()).toEqual({ count: 0 })
})

test('markAccountDeleting replaces UserMeter lease shadows from authoritative D1', async () => {
	const { sqlite, db } = createLeaseTestDb()
	addLeaseRepairsTable(sqlite)
	const meter = createInMemoryUserMeterEnv()
	const meterA = userMeterRpc({ env: meter.env, userId: 'user-a' })
	const drain = createWaitUntilDrain()

	// Stale shadow left behind by a failed release (no matching D1 lease).
	await meterA.shadowAcquireWriteLease({
		token: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
		holder: 'test:stale-shadow',
		acquiredAt: '2026-01-01 00:00:00',
	})
	expect(await meterA.countActiveWriteLeases()).toEqual({ count: 1 })

	let heldToken = ''
	let heldAcquiredAt = ''
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
		holder: 'test:active-d1',
		env: meter.env,
		waitUntil: drain.waitUntil,
		async write() {
			const [lease] = await listActiveAccountWriteLeases(db, 'user-a')
			heldToken = lease!.token
			heldAcquiredAt = lease!.acquired_at
			startWrite()
			await finish
			return 'lost'
		},
	})
	await started
	await drain.drain()
	expect(await meterA.countActiveWriteLeases()).toEqual({ count: 2 })

	await expect(
		markAccountDeleting({
			db,
			dbUserId: 1,
			now: new Date('2099-01-01T00:00:00.000Z'),
			env: meter.env,
			waitUntil: drain.waitUntil,
		}),
	).resolves.toBe(1)
	await drain.drain()
	expect(await meterA.readDeletionState()).toEqual({
		deletingAt: '2099-01-01 00:00:00',
	})
	// Stale shadow removed; active D1 lease preserved under the tombstone.
	expect(await meterA.listWriteLeases({})).toEqual({
		leases: [
			{
				token: heldToken,
				holder: 'test:active-d1',
				acquiredAt: heldAcquiredAt,
			},
		],
		nextStartAfter: null,
		truncated: false,
	})
	expect(await meterA.exportCounters({})).toMatchObject({
		deletionShadow: {
			deletingAt: '2099-01-01 00:00:00',
			activeWriteLeaseCount: 1,
			writeLeases: [{ acquiredAt: heldAcquiredAt }],
		},
	})

	await repairAccountWriteLease({
		db,
		stableUserId: 'user-a',
		token: heldToken,
		expectedAcquiredAt: heldAcquiredAt,
		repairedByUserId: 'admin-user',
		reason: 'Inspected worker crash and confirmed process termination.',
		env: meter.env,
		waitUntil: drain.waitUntil,
	})
	await drain.drain()
	finishWrite()
	await expect(operation).rejects.toBeInstanceOf(AccountWriteLeaseLostError)
	expect(await listActiveAccountWriteLeases(db, 'user-a')).toHaveLength(0)

	// Failed release after D1 drain can leave a stale shadow; retry clears it.
	await meterA.shadowReplaceDeletionState({
		deletingAt: '2099-01-01 00:00:00',
		leases: [
			{
				token: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
				holder: 'test:post-drain-stale',
				acquiredAt: '2099-01-01 00:01:00',
			},
		],
	})
	expect(await meterA.countActiveWriteLeases()).toEqual({ count: 1 })

	await expect(
		markAccountDeleting({
			db,
			dbUserId: 1,
			env: meter.env,
		}),
	).resolves.toBe(0)
	expect(await meterA.countActiveWriteLeases()).toEqual({ count: 0 })
	expect(await meterA.readDeletionState()).toEqual({
		deletingAt: '2099-01-01 00:00:00',
	})
})
