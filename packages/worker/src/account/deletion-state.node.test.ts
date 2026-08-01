import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	userMeterRpc,
	type UserMeterEnv,
} from '#worker/entitlements/user-meter-client.ts'
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

function createDeferred() {
	let resolve: () => void = () => undefined
	const promise = new Promise<void>((next) => {
		resolve = next
	})
	return { promise, resolve: () => resolve() }
}

function createGatedDoEnv(input: {
	releaseGate?: Promise<void>
	finalizeGate?: Promise<void>
	finalizeFailOnceError?: string
}) {
	const base = createInMemoryUserMeterEnv()
	const namespace = base.env.USER_METER!
	const gates = { releaseEntered: false, finalizeEntered: false }
	let finalizeAttempts = 0
	const env = {
		USER_METER: {
			idFromName: namespace.idFromName.bind(namespace),
			get(id: DurableObjectId) {
				const stub = namespace.get(id)
				return new Proxy(stub, {
					get(target, prop, receiver) {
						const value = Reflect.get(target, prop, receiver)
						if (prop === 'releaseWriteLease' && input.releaseGate) {
							return async (args: { token: string }) => {
								gates.releaseEntered = true
								await input.releaseGate
								return target.releaseWriteLease(args)
							}
						}
						if (prop === 'finalizeWriteLeaseRepair') {
							return async (args: {
								token: string
								repairId: string
								expectedAcquiredAt: string
							}) => {
								if (input.finalizeGate) {
									gates.finalizeEntered = true
									await input.finalizeGate
								}
								if (input.finalizeFailOnceError) {
									finalizeAttempts += 1
									if (finalizeAttempts === 1) {
										throw new Error(input.finalizeFailOnceError)
									}
								}
								return target.finalizeWriteLeaseRepair(args)
							}
						}
						return typeof value === 'function' ? value.bind(target) : value
					},
				})
			},
		},
	} as unknown as UserMeterEnv
	return {
		env,
		gates,
		get finalizeAttempts() {
			return finalizeAttempts
		},
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

function holdDoWriteLease(input: {
	db: D1Database
	env: UserMeterEnv
	holder: string
	stableUserId?: string
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const stableUserId = input.stableUserId ?? 'user-a'
	const finish = createDeferred()
	const started = createDeferred()
	let token = ''
	let acquiredAt = ''
	const operation = withAccountWriteLease({
		db: input.db,
		stableUserId,
		holder: input.holder,
		env: input.env,
		waitUntil: input.waitUntil,
		async write() {
			const [lease] = await listActiveAccountWriteLeases(
				input.db,
				stableUserId,
				input.env,
			)
			token = lease!.token
			acquiredAt = lease!.acquired_at
			started.resolve()
			await finish.promise
			return 'lost'
		},
	})
	return {
		operation,
		started: started.promise,
		finish: finish.resolve,
		get token() {
			return token
		},
		get acquiredAt() {
			return acquiredAt
		},
	}
}

test('env makes UserMeter authoritative for acquire/held/release with D1 deleting_at gate', async () => {
	const { sqlite, db } = createLeaseTestDb()
	addLeaseRepairsTable(sqlite)
	const meter = createInMemoryUserMeterEnv()
	const drain = createWaitUntilDrain()
	const meterA = userMeterRpc({ env: meter.env, userId: 'user-a' })
	const meterB = userMeterRpc({ env: meter.env, userId: 'user-b' })

	await withAccountWriteLease({
		db,
		stableUserId: 'user-a',
		holder: 'test:do-authority',
		env: meter.env,
		waitUntil: drain.waitUntil,
		async write() {
			expect(countLeaseRows(sqlite)).toBe(1)
			expect(
				await listActiveAccountWriteLeases(db, 'user-a', meter.env),
			).toHaveLength(1)
			expect(await listActiveAccountWriteLeases(db, 'user-a')).toHaveLength(1)
			expect(await meterA.countActiveWriteLeases()).toEqual({ count: 1 })
			return 'ok'
		},
	})
	await drain.drain()
	expect(
		await listActiveAccountWriteLeases(db, 'user-a', meter.env),
	).toHaveLength(0)
	expect(countLeaseRows(sqlite)).toBe(0)
	expect(await meterA.countActiveWriteLeases()).toEqual({ count: 0 })

	const held = holdDoWriteLease({
		db,
		env: meter.env,
		holder: 'test:do-repair',
		waitUntil: drain.waitUntil,
	})
	await held.started
	expect(await meterA.countActiveWriteLeases()).toEqual({ count: 1 })

	await expect(
		markAccountDeleting({
			db,
			dbUserId: 1,
			now: new Date('2099-01-01T00:00:00.000Z'),
			env: meter.env,
		}),
	).resolves.toBe(1)
	expect(await meterA.readDeletionState()).toEqual({
		deletingAt: '2099-01-01 00:00:00',
	})

	await repairAccountWriteLease({
		db,
		stableUserId: 'user-a',
		token: held.token,
		expectedAcquiredAt: held.acquiredAt,
		repairedByUserId: 'admin-user',
		reason: 'Inspected worker crash and confirmed process termination.',
		env: meter.env,
	})
	held.finish()
	await expect(held.operation).rejects.toBeInstanceOf(
		AccountWriteLeaseLostError,
	)
	expect(await meterA.countActiveWriteLeases()).toEqual({ count: 0 })
	expect(
		sqlite.prepare(`SELECT reason FROM account_write_lease_repairs`).get(),
	).toEqual({
		reason: 'Inspected worker crash and confirmed process termination.',
	})

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

test('email-style omitted env keeps exact D1 lease path', async () => {
	const { sqlite, db } = createLeaseTestDb()
	const meter = createInMemoryUserMeterEnv()
	const meterA = userMeterRpc({ env: meter.env, userId: 'user-a' })

	await withAccountWriteLease({
		db,
		stableUserId: 'user-a',
		holder: 'test:email-d1',
		async write() {
			expect(countLeaseRows(sqlite)).toBe(1)
			expect(await listActiveAccountWriteLeases(db, 'user-a')).toHaveLength(1)
			expect(await meterA.countActiveWriteLeases()).toEqual({ count: 0 })
			return 'ok'
		},
	})
	expect(countLeaseRows(sqlite)).toBe(0)
	expect(await meterA.countActiveWriteLeases()).toEqual({ count: 0 })
})

test('mixed D1 + DO leases drain/count/dedupe and admin union list', async () => {
	const { sqlite, db } = createLeaseTestDb()
	addLeaseRepairsTable(sqlite)
	const meter = createInMemoryUserMeterEnv()
	const meterA = userMeterRpc({ env: meter.env, userId: 'user-a' })
	const drain = createWaitUntilDrain()

	let d1Token = ''
	let d1AcquiredAt = ''
	let startD1: () => void = () => undefined
	let finishD1: () => void = () => undefined
	const d1Started = new Promise<void>((resolve) => {
		startD1 = resolve
	})
	const d1Finish = new Promise<void>((resolve) => {
		finishD1 = resolve
	})
	const d1Operation = withAccountWriteLease({
		db,
		stableUserId: 'user-a',
		holder: 'test:email-d1',
		waitUntil: drain.waitUntil,
		async write() {
			const [lease] = await listActiveAccountWriteLeases(db, 'user-a')
			d1Token = lease!.token
			d1AcquiredAt = lease!.acquired_at
			startD1()
			await d1Finish
			return 'd1'
		},
	})
	await d1Started

	let doToken = ''
	let doAcquiredAt = ''
	let startDo: () => void = () => undefined
	let finishDo: () => void = () => undefined
	const doStarted = new Promise<void>((resolve) => {
		startDo = resolve
	})
	const doFinish = new Promise<void>((resolve) => {
		finishDo = resolve
	})
	const doOperation = withAccountWriteLease({
		db,
		stableUserId: 'user-a',
		holder: 'test:do-authority',
		env: meter.env,
		waitUntil: drain.waitUntil,
		async write() {
			const [lease] = (
				await listActiveAccountWriteLeases(db, 'user-a', meter.env)
			).filter((row) => row.holder === 'test:do-authority')
			doToken = lease!.token
			doAcquiredAt = lease!.acquired_at
			startDo()
			await doFinish
			return 'do'
		},
	})
	await doStarted

	const union = await listActiveAccountWriteLeases(db, 'user-a', meter.env)
	expect(union).toHaveLength(2)
	expect(union.map((lease) => lease.holder).sort()).toEqual([
		'test:do-authority',
		'test:email-d1',
	])
	expect(await listActiveAccountWriteLeases(db, 'user-a')).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ token: d1Token, holder: 'test:email-d1' }),
			expect.objectContaining({ token: doToken, holder: 'test:do-authority' }),
		]),
	)
	expect(await listActiveAccountWriteLeases(db, 'user-a')).toHaveLength(2)

	await expect(
		markAccountDeleting({
			db,
			dbUserId: 1,
			now: new Date('2099-01-01T00:00:00.000Z'),
			env: meter.env,
		}),
	).resolves.toBe(2)
	expect(await meterA.listWriteLeases({})).toEqual({
		leases: expect.arrayContaining([
			expect.objectContaining({
				token: d1Token,
				holder: 'test:email-d1',
				authority: 'legacy',
			}),
			expect.objectContaining({
				token: doToken,
				holder: 'test:do-authority',
				authority: 'do',
			}),
		]),
		nextStartAfter: null,
		truncated: false,
	})

	await repairAccountWriteLease({
		db,
		stableUserId: 'user-a',
		token: d1Token,
		expectedAcquiredAt: d1AcquiredAt,
		repairedByUserId: 'admin-user',
		reason: 'Inspected email writer crash and confirmed process termination.',
		env: meter.env,
	})
	finishD1()
	await expect(d1Operation).rejects.toBeInstanceOf(AccountWriteLeaseLostError)

	await expect(
		markAccountDeleting({
			db,
			dbUserId: 1,
			env: meter.env,
		}),
	).resolves.toBe(1)

	await repairAccountWriteLease({
		db,
		stableUserId: 'user-a',
		token: doToken,
		expectedAcquiredAt: doAcquiredAt,
		repairedByUserId: 'admin-user',
		reason: 'Inspected DO writer crash and confirmed process termination.',
		env: meter.env,
	})
	finishDo()
	await expect(doOperation).rejects.toBeInstanceOf(AccountWriteLeaseLostError)
	await drain.drain()
	await expect(
		markAccountDeleting({
			db,
			dbUserId: 1,
			env: meter.env,
		}),
	).resolves.toBe(0)
})

test('nested/detached/waitUntil parity for DO-authority leases', async () => {
	const { sqlite, db } = createLeaseTestDb()
	const meter = createInMemoryUserMeterEnv()
	const meterA = userMeterRpc({ env: meter.env, userId: 'user-a' })

	const nested = await withAccountWriteLease({
		db,
		stableUserId: 'user-a',
		holder: 'test:outer-do',
		env: meter.env,
		async write() {
			expect(await meterA.countActiveWriteLeases()).toEqual({ count: 1 })
			return await withAccountWriteLease({
				db,
				stableUserId: 'user-a',
				holder: 'test:nested-do',
				env: meter.env,
				async write() {
					expect(await meterA.countActiveWriteLeases()).toEqual({ count: 1 })
					const active = await listActiveAccountWriteLeases(
						db,
						'user-a',
						meter.env,
					)
					expect(active).toHaveLength(1)
					expect(active[0]).toEqual(
						expect.objectContaining({ holder: 'test:outer-do' }),
					)
					return 'nested'
				},
			})
		},
	})
	expect(nested).toBe('nested')
	expect(await meterA.countActiveWriteLeases()).toEqual({ count: 0 })

	let detached: Promise<void> = Promise.resolve()
	let releaseOuter: () => void = () => undefined
	const outerReleased = new Promise<void>((resolve) => {
		releaseOuter = resolve
	})
	await withAccountWriteLease({
		db,
		stableUserId: 'user-a',
		holder: 'test:outer-do',
		env: meter.env,
		async write() {
			detached = (async () => {
				await outerReleased
				await withAccountWriteLease({
					db,
					stableUserId: 'user-a',
					holder: 'test:detached-do',
					env: meter.env,
					async write() {
						const active = await listActiveAccountWriteLeases(
							db,
							'user-a',
							meter.env,
						)
						expect(active).toHaveLength(1)
						expect(active[0]).toEqual(
							expect.objectContaining({ holder: 'test:detached-do' }),
						)
					},
				})
			})()
		},
	})
	releaseOuter()
	await detached
	expect(await meterA.countActiveWriteLeases()).toEqual({ count: 0 })
	expect(countLeaseRows(sqlite)).toBe(0)

	const release = createDeferred()
	const gated = createGatedDoEnv({ releaseGate: release.promise })
	const gatedMeter = gated.meterFor('user-a')
	const drain = createWaitUntilDrain()

	let settled = false
	const awaitedRelease = withAccountWriteLease({
		db,
		stableUserId: 'user-a',
		holder: 'test:await-do-release',
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
			(await gatedMeter.countActiveWriteLeases()).count === 1 &&
			!settled,
		'DO release gate',
	)
	release.resolve()
	await expect(awaitedRelease).resolves.toBe('ok')
	expect(await gatedMeter.countActiveWriteLeases()).toEqual({ count: 0 })

	const release2 = createDeferred()
	const gated2 = createGatedDoEnv({ releaseGate: release2.promise })
	const gatedMeter2 = gated2.meterFor('user-a')
	await expect(
		withAccountWriteLease({
			db,
			stableUserId: 'user-a',
			holder: 'test:detach-do-release',
			env: gated2.env,
			waitUntil: drain.waitUntil,
			async write() {
				return 'ok'
			},
		}),
	).resolves.toBe('ok')
	await waitFor(
		async () =>
			gated2.gates.releaseEntered &&
			(await gatedMeter2.countActiveWriteLeases()).count === 1,
		'detached DO release still held',
	)
	release2.resolve()
	await drain.drain()
	expect(await gatedMeter2.countActiveWriteLeases()).toEqual({ count: 0 })
})

test('D1 deleting_at gate fails closed after purge tombstone', async () => {
	const { db } = createLeaseTestDb()
	const meter = createInMemoryUserMeterEnv()
	const meterA = userMeterRpc({ env: meter.env, userId: 'user-a' })

	await markAccountDeleting({
		db,
		dbUserId: 1,
		now: new Date('2099-01-01T00:00:00.000Z'),
		env: meter.env,
	})
	await meterA.purge()
	expect(await meterA.readDeletionState()).toEqual({
		deletingAt: '2099-01-01 00:00:00',
	})
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
})

test('DO repair prepare/audit/finalize is idempotent and lease-lost aware', async () => {
	const { sqlite, db } = createLeaseTestDb()
	addLeaseRepairsTable(sqlite)
	const meter = createInMemoryUserMeterEnv()
	const meterA = userMeterRpc({ env: meter.env, userId: 'user-a' })
	const held = holdDoWriteLease({
		db,
		env: meter.env,
		holder: 'test:do-repair-protocol',
	})
	await held.started

	const prepared = await meterA.prepareWriteLeaseRepair({
		token: held.token,
		expectedAcquiredAt: held.acquiredAt,
	})
	expect(prepared).toEqual(
		expect.objectContaining({
			prepared: true,
			token: held.token,
			acquiredAt: held.acquiredAt,
		}),
	)
	const repairId =
		prepared.prepared === true ? prepared.repairId : 'missing-repair-id'
	const retried = await meterA.prepareWriteLeaseRepair({
		token: held.token,
		expectedAcquiredAt: held.acquiredAt,
	})
	expect(retried).toEqual(expect.objectContaining({ prepared: true, repairId }))
	expect(await meterA.assertWriteLeaseHeld({ token: held.token })).toEqual({
		held: true,
	})
	expect(await meterA.countActiveWriteLeases()).toEqual({ count: 1 })

	await expect(
		repairAccountWriteLease({
			db,
			stableUserId: 'user-a',
			token: held.token,
			expectedAcquiredAt: held.acquiredAt,
			repairedByUserId: 'admin-user',
			reason: 'Inspected worker crash and confirmed process termination.',
			env: meter.env,
		}),
	).resolves.toEqual({ repaired: true, repairId })
	expect(await meterA.assertWriteLeaseHeld({ token: held.token })).toEqual({
		held: false,
	})
	expect(countLeaseRows(sqlite)).toBe(0)
	expect(
		sqlite.prepare(`SELECT active_write_count FROM users WHERE id = 1`).get(),
	).toEqual({ active_write_count: 0 })
	expect(
		sqlite
			.prepare(
				`SELECT id, lease_token, lease_acquired_at FROM account_write_lease_repairs`,
			)
			.get(),
	).toEqual({
		id: repairId,
		lease_token: held.token,
		lease_acquired_at: held.acquiredAt,
	})

	await expect(
		repairAccountWriteLease({
			db,
			stableUserId: 'user-a',
			token: held.token,
			expectedAcquiredAt: held.acquiredAt,
			repairedByUserId: 'admin-user',
			reason: 'Inspected worker crash and confirmed process termination.',
			env: meter.env,
		}),
	).resolves.toEqual({ repaired: true, repairId })
	expect(
		sqlite
			.prepare(`SELECT COUNT(*) AS count FROM account_write_lease_repairs`)
			.get(),
	).toEqual({ count: 1 })
	expect(
		sqlite.prepare(`SELECT active_write_count FROM users WHERE id = 1`).get(),
	).toEqual({ active_write_count: 0 })

	held.finish()
	await expect(held.operation).rejects.toBeInstanceOf(
		AccountWriteLeaseLostError,
	)
})

test('USER_METER failures fail closed when env is supplied', async () => {
	const { db } = createLeaseTestDb()
	const failingEnv = {
		USER_METER: {
			idFromName: (name: string) => ({ name, toString: () => name }),
			get: () => ({
				async acquireWriteLease() {
					throw new Error('do acquire failed')
				},
				async markDeleting() {
					throw new Error('do mark failed')
				},
			}),
		},
	} as unknown as UserMeterEnv

	await expect(
		withAccountWriteLease({
			db,
			stableUserId: 'user-a',
			env: failingEnv,
			async write() {
				return 'mutated'
			},
		}),
	).rejects.toThrow('do acquire failed')

	await expect(
		markAccountDeleting({
			db,
			dbUserId: 1,
			env: failingEnv,
		}),
	).rejects.toThrow('do mark failed')

	await expect(
		withAccountWriteLease({
			db,
			stableUserId: 'user-a',
			env: {},
			async write() {
				return 'blocked'
			},
		}),
	).rejects.toThrow('USER_METER Durable Object binding is not configured.')
})

test('markAccountDeleting clears stale legacy rows and preserves DO-authority leases', async () => {
	const { db } = createLeaseTestDb()
	const meter = createInMemoryUserMeterEnv()
	const meterA = userMeterRpc({ env: meter.env, userId: 'user-a' })

	await meterA.shadowAcquireWriteLease({
		token: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
		holder: 'test:stale-legacy',
		acquiredAt: '2026-01-01 00:00:00',
	})
	await meterA.acquireWriteLease({
		token: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
		holder: 'test:do-held',
		acquiredAt: '2026-01-01 00:01:00',
	})
	expect(await meterA.countActiveWriteLeases()).toEqual({ count: 2 })

	await expect(
		markAccountDeleting({
			db,
			dbUserId: 1,
			now: new Date('2099-01-01T00:00:00.000Z'),
			env: meter.env,
		}),
	).resolves.toBe(1)
	expect(await meterA.listWriteLeases({})).toEqual({
		leases: [
			{
				token: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
				holder: 'test:do-held',
				acquiredAt: '2026-01-01 00:01:00',
				authority: 'do',
			},
		],
		nextStartAfter: null,
		truncated: false,
	})

	await meterA.shadowReplaceDeletionState({
		deletingAt: '2099-01-01 00:00:00',
		leases: [
			{
				token: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
				holder: 'test:post-drain-stale',
				acquiredAt: '2099-01-01 00:01:00',
			},
		],
	})
	expect(await meterA.countActiveWriteLeases()).toEqual({ count: 2 })
	await expect(
		markAccountDeleting({
			db,
			dbUserId: 1,
			env: meter.env,
		}),
	).resolves.toBe(1)
	expect(await meterA.listWriteLeases({})).toEqual({
		leases: [
			{
				token: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
				holder: 'test:do-held',
				acquiredAt: '2026-01-01 00:01:00',
				authority: 'do',
			},
		],
		nextStartAfter: null,
		truncated: false,
	})
})

test('old Phase-A D1-only mark counts a new DO-authority lease via D1 mirror', async () => {
	const { sqlite, db } = createLeaseTestDb()
	const meter = createInMemoryUserMeterEnv()
	const meterA = userMeterRpc({ env: meter.env, userId: 'user-a' })
	const drain = createWaitUntilDrain()

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
		holder: 'test:do-mirror-for-phase-a',
		env: meter.env,
		waitUntil: drain.waitUntil,
		async write() {
			startWrite()
			await finish
			return 'held'
		},
	})
	await started
	expect(countLeaseRows(sqlite)).toBe(1)
	expect(await meterA.countActiveWriteLeases()).toEqual({ count: 1 })

	await expect(
		markAccountDeleting({
			db,
			dbUserId: 1,
			now: new Date('2099-01-01T00:00:00.000Z'),
		}),
	).resolves.toBe(1)

	finishWrite()
	await expect(operation).resolves.toBe('held')
	await drain.drain()
	expect(countLeaseRows(sqlite)).toBe(0)
	expect(await meterA.countActiveWriteLeases()).toEqual({ count: 0 })
})

test('DO acquire fails closed and releases DO when D1 mirror response is lost unconfirmed', async () => {
	const { sqlite, db } = createLeaseTestDb()
	const meter = createInMemoryUserMeterEnv()
	const meterA = userMeterRpc({ env: meter.env, userId: 'user-a' })
	const originalBatch = db.batch.bind(db)
	db.batch = (async () => {
		throw new Error('simulated lost D1 batch response')
	}) as D1Database['batch']
	const originalPrepare = db.prepare.bind(db)
	db.prepare = ((query: string) => {
		const statement = originalPrepare(query)
		if (
			query.includes('INSERT INTO account_write_leases') ||
			query.includes('active_write_count + 1')
		) {
			return {
				bind(...params: Array<unknown>) {
					const bound = statement.bind(...params)
					return {
						async run() {
							return { meta: { changes: 0 } }
						},
						first: bound.first.bind(bound),
						all: bound.all.bind(bound),
					}
				},
			}
		}
		return statement
	}) as D1Database['prepare']

	await expect(
		withAccountWriteLease({
			db,
			stableUserId: 'user-a',
			holder: 'test:mirror-fail',
			env: meter.env,
			async write() {
				return 'should-not-run'
			},
		}),
	).rejects.toBeInstanceOf(AccountDeletionInProgressError)
	expect(countLeaseRows(sqlite)).toBe(0)
	expect(await meterA.countActiveWriteLeases()).toEqual({ count: 0 })
	db.batch = originalBatch
	db.prepare = originalPrepare
})

test('DO acquire cleans partial D1 mirror when insert commits and count returns false', async () => {
	const { sqlite, db } = createLeaseTestDb()
	const meter = createInMemoryUserMeterEnv()
	const meterA = userMeterRpc({ env: meter.env, userId: 'user-a' })
	const originalBatch = db.batch.bind(db)
	db.batch = (async () => {
		throw new Error('simulated lost D1 batch response')
	}) as D1Database['batch']
	const originalPrepare = db.prepare.bind(db)
	db.prepare = ((query: string) => {
		const statement = originalPrepare(query)
		if (query.includes('active_write_count + 1')) {
			return {
				bind(...params: Array<unknown>) {
					const bound = statement.bind(...params)
					return {
						async run() {
							return { meta: { changes: 0 } }
						},
						first: bound.first.bind(bound),
						all: bound.all.bind(bound),
					}
				},
			}
		}
		return statement
	}) as D1Database['prepare']
	let writeStarted = false

	await expect(
		withAccountWriteLease({
			db,
			stableUserId: 'user-a',
			holder: 'test:mirror-partial-false',
			env: meter.env,
			async write() {
				writeStarted = true
				return 'should-not-run'
			},
		}),
	).rejects.toBeInstanceOf(AccountDeletionInProgressError)
	expect(writeStarted).toBe(false)
	expect(countLeaseRows(sqlite)).toBe(0)
	expect(
		sqlite.prepare(`SELECT active_write_count FROM users WHERE id = 1`).get(),
	).toEqual({ active_write_count: 0 })
	expect(await meterA.countActiveWriteLeases()).toEqual({ count: 0 })
	db.batch = originalBatch
	db.prepare = originalPrepare
})

test('DO acquire cleans partial D1 mirror when sequential count throws after insert', async () => {
	const { sqlite, db } = createLeaseTestDb()
	const meter = createInMemoryUserMeterEnv()
	const meterA = userMeterRpc({ env: meter.env, userId: 'user-a' })
	const originalBatch = db.batch.bind(db)
	db.batch = (async () => {
		throw new Error('simulated lost D1 batch response')
	}) as D1Database['batch']
	const originalPrepare = db.prepare.bind(db)
	const countFailure = new Error('simulated sequential count failure')
	db.prepare = ((query: string) => {
		const statement = originalPrepare(query)
		if (query.includes('active_write_count + 1')) {
			return {
				bind(...params: Array<unknown>) {
					const bound = statement.bind(...params)
					return {
						async run() {
							throw countFailure
						},
						first: bound.first.bind(bound),
						all: bound.all.bind(bound),
					}
				},
			}
		}
		return statement
	}) as D1Database['prepare']
	let writeStarted = false

	await expect(
		withAccountWriteLease({
			db,
			stableUserId: 'user-a',
			holder: 'test:mirror-partial-throw',
			env: meter.env,
			async write() {
				writeStarted = true
				return 'should-not-run'
			},
		}),
	).rejects.toBe(countFailure)
	expect(writeStarted).toBe(false)
	expect(countLeaseRows(sqlite)).toBe(0)
	expect(
		sqlite.prepare(`SELECT active_write_count FROM users WHERE id = 1`).get(),
	).toEqual({ active_write_count: 0 })
	expect(await meterA.countActiveWriteLeases()).toEqual({ count: 0 })
	db.batch = originalBatch
	db.prepare = originalPrepare
})

test('DO repair clears D1 mirror, stays audit-first, and retries after finalize without double audit/count', async () => {
	const { sqlite, db } = createLeaseTestDb()
	addLeaseRepairsTable(sqlite)
	const meter = createInMemoryUserMeterEnv()
	const meterA = userMeterRpc({ env: meter.env, userId: 'user-a' })
	const held = holdDoWriteLease({
		db,
		env: meter.env,
		holder: 'test:do-repair-mirror',
	})
	await held.started
	expect(countLeaseRows(sqlite)).toBe(1)
	expect(
		sqlite.prepare(`SELECT active_write_count FROM users WHERE id = 1`).get(),
	).toEqual({ active_write_count: 1 })

	const prepared = await meterA.prepareWriteLeaseRepair({
		token: held.token,
		expectedAcquiredAt: held.acquiredAt,
	})
	expect(prepared.prepared).toBe(true)
	const repairId =
		prepared.prepared === true ? prepared.repairId : 'missing-repair-id'

	sqlite
		.prepare(
			`INSERT INTO account_write_lease_repairs (
				id, target_user_id, lease_token, lease_holder,
				lease_acquired_at, repaired_by_user_id, reason, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			repairId,
			'user-a',
			held.token,
			'test:do-repair-mirror',
			held.acquiredAt,
			'admin-user',
			'Inspected worker crash and confirmed process termination.',
			'2099-01-01 00:00:00',
		)
	expect(await meterA.assertWriteLeaseHeld({ token: held.token })).toEqual({
		held: true,
	})
	expect(countLeaseRows(sqlite)).toBe(1)

	await expect(
		repairAccountWriteLease({
			db,
			stableUserId: 'user-a',
			token: held.token,
			expectedAcquiredAt: held.acquiredAt,
			repairedByUserId: 'admin-user',
			reason: 'Inspected worker crash and confirmed process termination.',
			env: meter.env,
		}),
	).resolves.toEqual({ repaired: true, repairId })
	expect(await meterA.assertWriteLeaseHeld({ token: held.token })).toEqual({
		held: false,
	})
	expect(countLeaseRows(sqlite)).toBe(0)
	expect(
		sqlite.prepare(`SELECT active_write_count FROM users WHERE id = 1`).get(),
	).toEqual({ active_write_count: 0 })
	expect(
		sqlite
			.prepare(`SELECT COUNT(*) AS count FROM account_write_lease_repairs`)
			.get(),
	).toEqual({ count: 1 })

	await expect(
		repairAccountWriteLease({
			db,
			stableUserId: 'user-a',
			token: held.token,
			expectedAcquiredAt: held.acquiredAt,
			repairedByUserId: 'admin-user',
			reason: 'Inspected worker crash and confirmed process termination.',
			env: meter.env,
		}),
	).resolves.toEqual({ repaired: true, repairId })
	expect(
		sqlite
			.prepare(`SELECT COUNT(*) AS count FROM account_write_lease_repairs`)
			.get(),
	).toEqual({ count: 1 })
	expect(
		sqlite.prepare(`SELECT active_write_count FROM users WHERE id = 1`).get(),
	).toEqual({ active_write_count: 0 })

	held.finish()
	await expect(held.operation).rejects.toBeInstanceOf(
		AccountWriteLeaseLostError,
	)
})

test('authoritative release cleans D1 mirror after DO release under waitUntil', async () => {
	const { sqlite, db } = createLeaseTestDb()
	const release = createDeferred()
	const gated = createGatedDoEnv({ releaseGate: release.promise })
	const gatedMeter = gated.meterFor('user-a')
	const drain = createWaitUntilDrain()

	await expect(
		withAccountWriteLease({
			db,
			stableUserId: 'user-a',
			holder: 'test:release-mirror-order',
			env: gated.env,
			waitUntil: drain.waitUntil,
			async write() {
				expect(countLeaseRows(sqlite)).toBe(1)
				return 'ok'
			},
		}),
	).resolves.toBe('ok')
	await waitFor(
		async () =>
			gated.gates.releaseEntered &&
			(await gatedMeter.countActiveWriteLeases()).count === 1 &&
			countLeaseRows(sqlite) === 1,
		'DO release gated while D1 mirror still held',
	)

	release.resolve()
	await drain.drain()
	expect(await gatedMeter.countActiveWriteLeases()).toEqual({ count: 0 })
	expect(countLeaseRows(sqlite)).toBe(0)
	expect(
		sqlite.prepare(`SELECT active_write_count FROM users WHERE id = 1`).get(),
	).toEqual({ active_write_count: 0 })
})

test('repair keeps D1 mirror until finalize; Phase-A mark counts during gate then drains', async () => {
	const { sqlite, db } = createLeaseTestDb()
	addLeaseRepairsTable(sqlite)
	const finalize = createDeferred()
	const gated = createGatedDoEnv({ finalizeGate: finalize.promise })
	const gatedMeter = gated.meterFor('user-a')
	const held = holdDoWriteLease({
		db,
		env: gated.env,
		holder: 'test:repair-finalize-gate',
	})
	await held.started

	let repairSettled = false
	const repairPromise = repairAccountWriteLease({
		db,
		stableUserId: 'user-a',
		token: held.token,
		expectedAcquiredAt: held.acquiredAt,
		repairedByUserId: 'admin-user',
		reason: 'Inspected worker crash and confirmed process termination.',
		env: gated.env,
	}).then((result) => {
		repairSettled = true
		return result
	})
	await waitFor(
		async () =>
			gated.gates.finalizeEntered &&
			(await gatedMeter.assertWriteLeaseHeld({ token: held.token })).held &&
			countLeaseRows(sqlite) === 1 &&
			!repairSettled,
		'finalize gated with DO + D1 mirror still held',
	)

	await expect(
		markAccountDeleting({
			db,
			dbUserId: 1,
			now: new Date('2099-01-01T00:00:00.000Z'),
		}),
	).resolves.toBe(1)

	finalize.resolve()
	await expect(repairPromise).resolves.toEqual(
		expect.objectContaining({ repaired: true }),
	)
	expect(await gatedMeter.assertWriteLeaseHeld({ token: held.token })).toEqual({
		held: false,
	})
	expect(countLeaseRows(sqlite)).toBe(0)
	await expect(markAccountDeleting({ db, dbUserId: 1 })).resolves.toBe(0)

	held.finish()
	await expect(held.operation).rejects.toBeInstanceOf(
		AccountWriteLeaseLostError,
	)
})

test('lost finalize response retries clear stale D1 mirror and return stable repairId', async () => {
	const { sqlite, db } = createLeaseTestDb()
	addLeaseRepairsTable(sqlite)
	const meter = createInMemoryUserMeterEnv()
	const meterA = userMeterRpc({ env: meter.env, userId: 'user-a' })
	const held = holdDoWriteLease({
		db,
		env: meter.env,
		holder: 'test:stale-mirror-after-finalize',
	})
	await held.started

	const prepared = await meterA.prepareWriteLeaseRepair({
		token: held.token,
		expectedAcquiredAt: held.acquiredAt,
	})
	const repairId =
		prepared.prepared === true ? prepared.repairId : 'missing-repair-id'
	sqlite
		.prepare(
			`INSERT INTO account_write_lease_repairs (
				id, target_user_id, lease_token, lease_holder,
				lease_acquired_at, repaired_by_user_id, reason, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			repairId,
			'user-a',
			held.token,
			'test:stale-mirror-after-finalize',
			held.acquiredAt,
			'admin-user',
			'Inspected worker crash and confirmed process termination.',
			'2099-01-01 00:00:00',
		)
	await meterA.finalizeWriteLeaseRepair({
		token: held.token,
		repairId,
		expectedAcquiredAt: held.acquiredAt,
	})
	expect(await meterA.assertWriteLeaseHeld({ token: held.token })).toEqual({
		held: false,
	})
	expect(countLeaseRows(sqlite)).toBe(1)
	expect(
		sqlite.prepare(`SELECT active_write_count FROM users WHERE id = 1`).get(),
	).toEqual({ active_write_count: 1 })

	await expect(
		repairAccountWriteLease({
			db,
			stableUserId: 'user-a',
			token: held.token,
			expectedAcquiredAt: held.acquiredAt,
			repairedByUserId: 'admin-user',
			reason: 'Inspected worker crash and confirmed process termination.',
			env: meter.env,
		}),
	).resolves.toEqual({ repaired: true, repairId })
	expect(countLeaseRows(sqlite)).toBe(0)
	expect(
		sqlite.prepare(`SELECT active_write_count FROM users WHERE id = 1`).get(),
	).toEqual({ active_write_count: 0 })
	expect(
		sqlite
			.prepare(`SELECT COUNT(*) AS count FROM account_write_lease_repairs`)
			.get(),
	).toEqual({ count: 1 })

	held.finish()
	await expect(held.operation).rejects.toBeInstanceOf(
		AccountWriteLeaseLostError,
	)
})

test('finalize failure without commit leaves D1 mirror held for retry', async () => {
	const { sqlite, db } = createLeaseTestDb()
	addLeaseRepairsTable(sqlite)
	const gated = createGatedDoEnv({
		finalizeFailOnceError: 'simulated finalize transport failure',
	})
	const meterA = gated.meterFor('user-a')
	const held = holdDoWriteLease({
		db,
		env: gated.env,
		holder: 'test:finalize-fail-closed',
	})
	await held.started

	await expect(
		repairAccountWriteLease({
			db,
			stableUserId: 'user-a',
			token: held.token,
			expectedAcquiredAt: held.acquiredAt,
			repairedByUserId: 'admin-user',
			reason: 'Inspected worker crash and confirmed process termination.',
			env: gated.env,
		}),
	).rejects.toThrow('simulated finalize transport failure')
	expect(await meterA.assertWriteLeaseHeld({ token: held.token })).toEqual({
		held: true,
	})
	expect(countLeaseRows(sqlite)).toBe(1)
	expect(
		sqlite.prepare(`SELECT active_write_count FROM users WHERE id = 1`).get(),
	).toEqual({ active_write_count: 1 })

	await expect(
		repairAccountWriteLease({
			db,
			stableUserId: 'user-a',
			token: held.token,
			expectedAcquiredAt: held.acquiredAt,
			repairedByUserId: 'admin-user',
			reason: 'Inspected worker crash and confirmed process termination.',
			env: gated.env,
		}),
	).resolves.toEqual(expect.objectContaining({ repaired: true }))
	expect(await meterA.assertWriteLeaseHeld({ token: held.token })).toEqual({
		held: false,
	})
	expect(countLeaseRows(sqlite)).toBe(0)
	expect(gated.finalizeAttempts).toBe(2)

	held.finish()
	await expect(held.operation).rejects.toBeInstanceOf(
		AccountWriteLeaseLostError,
	)
})
