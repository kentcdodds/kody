import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	userMeterRpc,
	type UserMeterEnv,
} from '#worker/entitlements/user-meter-client.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import {
	AccountDeletionInProgressError,
	AccountWriteLeaseLostError,
	listActiveAccountWriteLeases,
	markAccountDeleting,
	repairAccountWriteLease,
	withAccountWriteLease,
} from './deletion-state.ts'

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
	await vi
		.waitFor(
			async () => {
				expect(await predicate()).toBe(true)
			},
			{ timeout: 2_000, interval: 1 },
		)
		.catch(() => {
			throw new Error(`Timed out waiting for ${label}`)
		})
}

function holdDoWriteLease(input: {
	db: D1Database
	env: UserMeterEnv
	holder: string
	stableUserId?: string
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
		async write() {
			const [lease] = await listActiveAccountWriteLeases(
				input.env,
				stableUserId,
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

test('env is required: UserMeter authoritative for acquire/held/release with D1 deleting_at gate', async () => {
	const { sqlite, db } = createLeaseTestDb()
	addLeaseRepairsTable(sqlite)
	const meter = createInMemoryUserMeterEnv()
	const meterA = userMeterRpc({ env: meter.env, userId: 'user-a' })
	const meterB = userMeterRpc({ env: meter.env, userId: 'user-b' })

	await withAccountWriteLease({
		db,
		stableUserId: 'user-a',
		holder: 'test:do-authority',
		env: meter.env,
		async write() {
			expect(
				await listActiveAccountWriteLeases(meter.env, 'user-a'),
			).toHaveLength(1)
			expect(await meterA.countActiveWriteLeases()).toEqual({ count: 1 })
			return 'ok'
		},
	})
	expect(await listActiveAccountWriteLeases(meter.env, 'user-a')).toHaveLength(
		0,
	)
	expect(await meterA.countActiveWriteLeases()).toEqual({ count: 0 })

	const held = holdDoWriteLease({
		db,
		env: meter.env,
		holder: 'test:do-repair',
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
		async write() {
			return 'ok'
		},
	})
	expect(await meterB.readDeletionState()).toEqual({ deletingAt: null })
})

test('nested same-user lease reuses the outer lease instead of re-acquiring', async () => {
	const { db } = createLeaseTestDb()
	const meter = createInMemoryUserMeterEnv()
	const meterA = userMeterRpc({ env: meter.env, userId: 'user-a' })

	const result = await withAccountWriteLease({
		db,
		stableUserId: 'user-a',
		holder: 'test:outer',
		env: meter.env,
		async write() {
			expect(await meterA.countActiveWriteLeases()).toEqual({ count: 1 })
			return await withAccountWriteLease({
				db,
				stableUserId: 'user-a',
				holder: 'test:nested',
				env: meter.env,
				async write() {
					// Still only the outer lease: the nested call must not pay
					// another acquire/release round trip.
					expect(await meterA.countActiveWriteLeases()).toEqual({ count: 1 })
					const active = await listActiveAccountWriteLeases(meter.env, 'user-a')
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
	expect(await listActiveAccountWriteLeases(meter.env, 'user-a')).toHaveLength(
		0,
	)
})

test('nested lease for a different user still acquires its own lease', async () => {
	const { db } = createLeaseTestDb()
	const meter = createInMemoryUserMeterEnv()
	const meterA = userMeterRpc({ env: meter.env, userId: 'user-a' })
	const meterB = userMeterRpc({ env: meter.env, userId: 'user-b' })

	await withAccountWriteLease({
		db,
		stableUserId: 'user-a',
		holder: 'test:outer',
		env: meter.env,
		async write() {
			await withAccountWriteLease({
				db,
				stableUserId: 'user-b',
				holder: 'test:other-user',
				env: meter.env,
				async write() {
					expect(await meterA.countActiveWriteLeases()).toEqual({ count: 1 })
					expect(await meterB.countActiveWriteLeases()).toEqual({ count: 1 })
					expect(
						await listActiveAccountWriteLeases(meter.env, 'user-b'),
					).toHaveLength(1)
				},
			})
		},
	})
	expect(await listActiveAccountWriteLeases(meter.env, 'user-a')).toHaveLength(
		0,
	)
	expect(await listActiveAccountWriteLeases(meter.env, 'user-b')).toHaveLength(
		0,
	)
})

test('detached work spawned inside write re-acquires after the outer lease releases', async () => {
	const { db } = createLeaseTestDb()
	const meter = createInMemoryUserMeterEnv()
	const meterA = userMeterRpc({ env: meter.env, userId: 'user-a' })
	let detached: Promise<void> = Promise.resolve()
	let releaseOuter: () => void = () => undefined
	const outerReleased = new Promise<void>((resolve) => {
		releaseOuter = resolve
	})
	await withAccountWriteLease({
		db,
		stableUserId: 'user-a',
		holder: 'test:outer',
		env: meter.env,
		async write() {
			// Created inside the lease scope (inheriting the AsyncLocalStorage
			// context) but running only after the outer lease has been released.
			detached = (async () => {
				await outerReleased
				await withAccountWriteLease({
					db,
					stableUserId: 'user-a',
					holder: 'test:detached',
					env: meter.env,
					async write() {
						const active = await listActiveAccountWriteLeases(
							meter.env,
							'user-a',
						)
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
	expect(await meterA.countActiveWriteLeases()).toEqual({ count: 0 })
})

test('sequential sibling leases each acquire after the previous released', async () => {
	const { db } = createLeaseTestDb()
	const meter = createInMemoryUserMeterEnv()
	const meterA = userMeterRpc({ env: meter.env, userId: 'user-a' })

	await withAccountWriteLease({
		db,
		stableUserId: 'user-a',
		env: meter.env,
		async write() {
			expect(await meterA.countActiveWriteLeases()).toEqual({ count: 1 })
		},
	})
	await withAccountWriteLease({
		db,
		stableUserId: 'user-a',
		env: meter.env,
		async write() {
			expect(await meterA.countActiveWriteLeases()).toEqual({ count: 1 })
			expect(
				await listActiveAccountWriteLeases(meter.env, 'user-a'),
			).toHaveLength(1)
		},
	})
	expect(await listActiveAccountWriteLeases(meter.env, 'user-a')).toHaveLength(
		0,
	)
})

test('nested/detached parity for DO-authority leases', async () => {
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
					const active = await listActiveAccountWriteLeases(meter.env, 'user-a')
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
							meter.env,
							'user-a',
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

	// Release is awaited: withAccountWriteLease does not settle until DO release completes.
	const release = createDeferred()
	const gated = createGatedDoEnv({ releaseGate: release.promise })
	const gatedMeter = gated.meterFor('user-a')

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

	// Idempotent retry returns the same repairId without creating a second audit row.
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

	held.finish()
	await expect(held.operation).rejects.toBeInstanceOf(
		AccountWriteLeaseLostError,
	)
})

test('USER_METER failures fail closed (missing binding throws)', async () => {
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

test('env path uses UserMeter leases without D1 mirror operations', async () => {
	const { db } = createLeaseTestDb()
	const meter = createInMemoryUserMeterEnv()
	const meterA = userMeterRpc({ env: meter.env, userId: 'user-a' })

	// Verify D1 batch is not called on the env/DO path after mirror retirement.
	const originalBatch = db.batch.bind(db)
	db.batch = (async () => {
		throw new Error(
			'D1 batch must not be called in env path after mirror retirement',
		)
	}) as D1Database['batch']
	const mirrorCalls: Array<string> = []
	const originalPrepare = db.prepare.bind(db)
	db.prepare = ((query: string) => {
		if (query.includes('active_write_count')) {
			mirrorCalls.push(query)
		}
		return originalPrepare(query)
	}) as D1Database['prepare']

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
		holder: 'test:do-no-mirror',
		env: meter.env,
		async write() {
			startWrite()
			await finish
			return 'held'
		},
	})
	await started
	expect(await meterA.countActiveWriteLeases()).toEqual({ count: 1 })

	finishWrite()
	await expect(operation).resolves.toBe('held')
	expect(await meterA.countActiveWriteLeases()).toEqual({ count: 0 })
	// No legacy counter calls from the env path.
	expect(mirrorCalls).toHaveLength(0)

	db.batch = originalBatch
	db.prepare = originalPrepare
})

test('DO repair is audit-first: prepare + audit row before finalize, absent D1 mirror', async () => {
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

	const prepared = await meterA.prepareWriteLeaseRepair({
		token: held.token,
		expectedAcquiredAt: held.acquiredAt,
	})
	expect(prepared.prepared).toBe(true)
	const repairId =
		prepared.prepared === true ? prepared.repairId : 'missing-repair-id'

	// Manually insert the audit row (simulating the audit-first write from repairAccountWriteLease).
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
	expect(
		sqlite
			.prepare(`SELECT COUNT(*) AS count FROM account_write_lease_repairs`)
			.get(),
	).toEqual({ count: 1 })

	// Idempotent retry returns the same repairId.
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

	held.finish()
	await expect(held.operation).rejects.toBeInstanceOf(
		AccountWriteLeaseLostError,
	)
})

test('lost-finalize retry returns stable repairId and leaves DO released', async () => {
	const { sqlite, db } = createLeaseTestDb()
	addLeaseRepairsTable(sqlite)
	const meter = createInMemoryUserMeterEnv()
	const meterA = userMeterRpc({ env: meter.env, userId: 'user-a' })
	const held = holdDoWriteLease({
		db,
		env: meter.env,
		holder: 'test:stale-after-finalize',
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
			'test:stale-after-finalize',
			held.acquiredAt,
			'admin-user',
			'Inspected worker crash and confirmed process termination.',
			'2099-01-01 00:00:00',
		)
	// Simulate: finalize completed but the repairAccountWriteLease response was lost.
	await meterA.finalizeWriteLeaseRepair({
		token: held.token,
		repairId,
		expectedAcquiredAt: held.acquiredAt,
	})
	expect(await meterA.assertWriteLeaseHeld({ token: held.token })).toEqual({
		held: false,
	})

	// Retry with the same reason returns the stable repairId.
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

	held.finish()
	await expect(held.operation).rejects.toBeInstanceOf(
		AccountWriteLeaseLostError,
	)
})

test('finalize failure leaves DO held and retry succeeds', async () => {
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

	// Retry succeeds on second finalize attempt.
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
	expect(gated.finalizeAttempts).toBe(2)

	held.finish()
	await expect(held.operation).rejects.toBeInstanceOf(
		AccountWriteLeaseLostError,
	)
})

test('D1 deleting_at race: gate queries D1 before DO acquire', async () => {
	// The D1 deleting_at query happens first; a concurrent deletion that sets D1
	// deleting_at before the DO acquire will block new leases cleanly.
	const { sqlite, db } = createLeaseTestDb()
	const meter = createInMemoryUserMeterEnv()
	const meterA = userMeterRpc({ env: meter.env, userId: 'user-a' })

	// Pre-mark D1 deleting_at (simulates another worker racing to delete).
	sqlite
		.prepare(
			`UPDATE users SET deleting_at = '2099-01-01 00:00:00' WHERE id = 1`,
		)
		.run()

	await expect(
		withAccountWriteLease({
			db,
			stableUserId: 'user-a',
			env: meter.env,
			async write() {
				return 'should not run'
			},
		}),
	).rejects.toBeInstanceOf(AccountDeletionInProgressError)
	// DO was never asked to acquire.
	expect(await meterA.countActiveWriteLeases()).toEqual({ count: 0 })
})

test('export: deletion state includes active lease count and acquiredAt list', async () => {
	const { db } = createLeaseTestDb()
	const meter = createInMemoryUserMeterEnv()
	const meterA = userMeterRpc({ env: meter.env, userId: 'user-a' })

	const held = holdDoWriteLease({
		db,
		env: meter.env,
		holder: 'test:export',
	})
	await held.started

	const exported = await meterA.exportCounters({ pageSize: 1 })
	expect(exported.deletionState).toEqual({
		deletingAt: null,
		activeWriteLeaseCount: 1,
		writeLeases: [{ acquiredAt: expect.any(String) }],
	})

	held.finish()
	await expect(held.operation).resolves.toBe('lost')
})

test('purge resets lease state but preserves deletingAt tombstone', async () => {
	const { db } = createLeaseTestDb()
	const meter = createInMemoryUserMeterEnv()
	const meterA = userMeterRpc({ env: meter.env, userId: 'user-a' })

	// Hold a lease while the account is still writable (before marking for deletion).
	const held = holdDoWriteLease({
		db,
		env: meter.env,
		holder: 'test:pre-purge',
		stableUserId: 'user-a',
	})
	await held.started
	expect(await meterA.countActiveWriteLeases()).toEqual({ count: 1 })

	// Now mark for deletion; DO tombstone is set, purge will clear leases.
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
	// D1 gate still blocks (deleting_at is permanent).
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
	held.finish()
	await expect(held.operation).rejects.toBeInstanceOf(
		AccountWriteLeaseLostError,
	)
})
