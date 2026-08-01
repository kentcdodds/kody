import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { seedAccount } from '#worker/test-support/workers-seed.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { userMeterDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import { EntitlementLimitError } from './errors.ts'
import { planLimits } from './plans.ts'
import {
	assertWithinStorageBytesEntitlement,
	consumeDailyEntitlement,
	readUserD1StorageBytes,
	refundDailyEntitlement,
} from './service.ts'
import { ensureEntitlementTestSchema } from './test-schema.ts'
import { userMeterRpc } from './user-meter-client.ts'
import { UserMeter, userMeterMirrorUpdatedAtToken } from './user-meter-do.ts'
import {
	createWaitUntilDrain,
	withPatchedDbPrepare,
} from '#worker/test-support/user-meter.ts'

async function seedFreeUser(emailPrefix: string) {
	await ensureEntitlementTestSchema(env.APP_DB)
	const email = `${emailPrefix}-${crypto.randomUUID()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	await seedAccount({
		db: env.APP_DB,
		email,
		username: `meter-${crypto.randomUUID().slice(0, 8)}`,
		plan: 'free',
		stableUserId: userId,
	})
	return { email, userId }
}

async function readD1DailyCount(input: {
	userId: string
	resource: string
	day: string
}) {
	const row = await env.APP_DB.prepare(
		`SELECT count, updated_at FROM entitlement_daily_counters
		WHERE user_id = ? AND resource = ? AND day = ?`,
	)
		.bind(input.userId, input.resource, input.day)
		.first<{ count: number; updated_at: string }>()
	return row
		? { count: Number(row.count), updatedAt: String(row.updated_at) }
		: null
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 5_000,
	label = 'condition',
) {
	const started = Date.now()
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) {
			throw new Error(`Timed out waiting for ${label}.`)
		}
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
}

const mirrorSql = `INSERT INTO entitlement_daily_counters (user_id, resource, day, count, updated_at)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(user_id, resource, day) DO UPDATE SET
				count = excluded.count,
				updated_at = excluded.updated_at
			WHERE entitlement_daily_counters.updated_at < excluded.updated_at`

test('UserMeter bootstraps from legacy D1 once, then warms without APP_DB awaits', async () => {
	const now = new Date('2026-07-31T15:00:00.000Z')
	const day = utcDayKey(now)
	const sendLimit = planLimits.free.maxEmailSendsPerDay
	const user = await seedFreeUser('meter-bootstrap')
	const drain = createWaitUntilDrain()
	const meter = userMeterRpc({ env, userId: user.userId })

	const legacyCount = sendLimit - 1
	await env.APP_DB.prepare(
		`INSERT INTO entitlement_daily_counters (user_id, resource, day, count, updated_at)
			VALUES (?, ?, ?, ?, ?)`,
	)
		.bind(
			user.userId,
			'email_sends_per_day',
			day,
			legacyCount,
			'2026-07-31T12:00:00.000Z',
		)
		.run()

	let d1PointReads = 0
	using _patch = withPatchedDbPrepare(env.APP_DB, (originalPrepare) => {
		return ((query: string) => {
			const statement = originalPrepare(query)
			const isPointRead =
				query.includes('SELECT count FROM entitlement_daily_counters') &&
				query.includes('WHERE user_id = ? AND resource = ? AND day = ?')
			const originalBind = statement.bind.bind(statement)
			return {
				bind(...params: Array<unknown>) {
					const bound = originalBind(...params)
					return {
						first: async <T>() => {
							if (isPointRead) d1PointReads += 1
							return await bound.first<T>()
						},
						all: bound.all.bind(bound),
						raw: bound.raw?.bind(bound),
						run: bound.run.bind(bound),
					}
				},
			}
		}) as D1Database['prepare']
	})

	await consumeDailyEntitlement({
		db: env.APP_DB,
		env,
		userId: user.userId,
		email: user.email,
		resource: 'email_sends_per_day',
		now,
		waitUntil: drain.waitUntil,
	})
	expect(d1PointReads).toBe(1)
	expect(
		await meter.read({ resource: 'email_sends_per_day', day }),
	).toMatchObject({
		outcome: 'ready',
		count: sendLimit,
	})

	const denied = await consumeDailyEntitlement({
		db: env.APP_DB,
		env,
		userId: user.userId,
		email: user.email,
		resource: 'email_sends_per_day',
		now,
		waitUntil: drain.waitUntil,
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	expect(denied).toBeInstanceOf(EntitlementLimitError)
	expect(denied).toMatchObject({
		details: {
			resource: 'email_sends_per_day',
			plan: 'free',
			limit: sendLimit,
			current: sendLimit,
		},
	})
	expect(d1PointReads).toBe(1)

	await refundDailyEntitlement({
		db: env.APP_DB,
		env,
		userId: user.userId,
		resource: 'email_sends_per_day',
		now,
		waitUntil: drain.waitUntil,
	})
	await drain.drain()
	d1PointReads = 0
	let nonMirrorAppDbRuns = 0
	let releaseMirror!: () => void
	const mirrorGate = new Promise<void>((resolve) => {
		releaseMirror = resolve
	})
	let mirrorRunStarted = false
	using _warmPatch = withPatchedDbPrepare(env.APP_DB, (originalPrepare) => {
		return ((query: string) => {
			const statement = originalPrepare(query)
			const isMirrorWrite =
				query.includes('INSERT INTO entitlement_daily_counters') &&
				query.includes('updated_at < excluded.updated_at')
			const isPointRead =
				query.includes('SELECT count FROM entitlement_daily_counters') &&
				query.includes('WHERE user_id = ? AND resource = ? AND day = ?')
			const originalBind = statement.bind.bind(statement)
			return {
				bind(...params: Array<unknown>) {
					const bound = originalBind(...params)
					return {
						first: async <T>() => {
							if (isPointRead) d1PointReads += 1
							return await bound.first<T>()
						},
						all: bound.all.bind(bound),
						raw: bound.raw?.bind(bound),
						run: async () => {
							if (isMirrorWrite) {
								mirrorRunStarted = true
								await mirrorGate
								return await bound.run()
							}
							nonMirrorAppDbRuns += 1
							return await bound.run()
						},
					}
				},
			}
		}) as D1Database['prepare']
	})
	try {
		await expect(
			consumeDailyEntitlement({
				db: env.APP_DB,
				env,
				userId: user.userId,
				email: user.email,
				resource: 'email_sends_per_day',
				now,
				waitUntil: drain.waitUntil,
			}),
		).resolves.toBeUndefined()
		expect(mirrorRunStarted).toBe(true)
		expect(d1PointReads).toBe(0)
		expect(nonMirrorAppDbRuns).toBe(0)
	} finally {
		releaseMirror()
	}
	await drain.drain()
}, 30_000)

test('UserMeter mirror tokens reject out-of-order absolute D1 writes', async () => {
	const now = new Date('2026-07-31T16:00:00.000Z')
	const day = utcDayKey(now)
	const user = await seedFreeUser('meter-mirror-order')
	const meter = userMeterRpc({ env, userId: user.userId })

	await meter.initialize({
		resource: 'email_sends_per_day',
		day,
		count: 0,
		updatedAt: now.toISOString(),
	})
	const first = await meter.consume({
		resource: 'email_sends_per_day',
		day,
		limit: 100,
		updatedAt: now.toISOString(),
	})
	expect(first).toMatchObject({
		outcome: 'ready',
		consumed: true,
		count: 1,
		revision: 2,
	})
	const second = await meter.consume({
		resource: 'email_sends_per_day',
		day,
		limit: 100,
		updatedAt: now.toISOString(),
	})
	expect(second).toMatchObject({
		outcome: 'ready',
		consumed: true,
		count: 2,
		revision: 3,
	})
	const refunded = await meter.refund({
		resource: 'email_sends_per_day',
		day,
		updatedAt: now.toISOString(),
	})
	expect(refunded).toMatchObject({
		outcome: 'ready',
		count: 1,
		revision: 4,
	})
	if (first.outcome !== 'ready') {
		throw new Error('Expected ready consume results.')
	}

	type PendingMirror = {
		count: number
		mirrorUpdatedAt: string
		resolve: () => void
		promise: Promise<void>
	}
	const pending: Array<PendingMirror> = []
	function deferMirror(count: number, mirrorUpdatedAt: string) {
		let resolve!: () => void
		const promise = new Promise<void>((res) => {
			resolve = res
		})
		pending.push({ count, mirrorUpdatedAt, resolve, promise })
		return promise
	}

	using _patch = withPatchedDbPrepare(env.APP_DB, (originalPrepare) => {
		return ((query: string) => {
			const statement = originalPrepare(query)
			const isMirrorWrite =
				query.includes('INSERT INTO entitlement_daily_counters') &&
				query.includes('updated_at < excluded.updated_at')
			const originalBind = statement.bind.bind(statement)
			return {
				bind(...params: Array<unknown>) {
					const bound = originalBind(...params)
					return {
						first: bound.first.bind(bound),
						all: bound.all.bind(bound),
						raw: bound.raw?.bind(bound),
						run: async () => {
							if (!isMirrorWrite) return await bound.run()
							await deferMirror(Number(params[3]), String(params[4]))
							return await bound.run()
						},
					}
				},
			}
		}) as D1Database['prepare']
	})

	const older = env.APP_DB.prepare(mirrorSql)
		.bind(
			user.userId,
			'email_sends_per_day',
			day,
			first.count,
			first.mirrorUpdatedAt,
		)
		.run()
	const newer = env.APP_DB.prepare(mirrorSql)
		.bind(
			user.userId,
			'email_sends_per_day',
			day,
			refunded.count,
			refunded.mirrorUpdatedAt,
		)
		.run()

	await waitFor(() => pending.length === 2, 5_000, 'mirror gates')
	expect(pending.map((entry) => entry.mirrorUpdatedAt)).toEqual([
		userMeterMirrorUpdatedAtToken(2),
		userMeterMirrorUpdatedAtToken(4),
	])
	const [olderGate, newerGate] = pending
	newerGate!.resolve()
	await newer
	expect(
		await readD1DailyCount({
			userId: user.userId,
			resource: 'email_sends_per_day',
			day,
		}),
	).toEqual({
		count: 1,
		updatedAt: userMeterMirrorUpdatedAtToken(4),
	})

	olderGate!.resolve()
	await older
	expect(
		await readD1DailyCount({
			userId: user.userId,
			resource: 'email_sends_per_day',
			day,
		}),
	).toEqual({
		count: 1,
		updatedAt: userMeterMirrorUpdatedAtToken(4),
	})
	expect(
		await meter.read({ resource: 'email_sends_per_day', day }),
	).toMatchObject({ outcome: 'ready', count: 1, revision: 4 })
}, 30_000)

test('UserMeter daily entitlement consume/refund/read/export/purge workflow is per-user and mirror-safe', async () => {
	const now = new Date('2026-07-31T15:00:00.000Z')
	const day = utcDayKey(now)
	const sendLimit = planLimits.free.maxEmailSendsPerDay
	const userA = await seedFreeUser('meter-a')
	const userB = await seedFreeUser('meter-b')
	const drain = createWaitUntilDrain()
	const meterA = userMeterRpc({ env, userId: userA.userId })
	const meterB = userMeterRpc({ env, userId: userB.userId })

	expect(userMeterDurableObjectName(userA.userId)).toBe(userA.userId)

	await meterA.initialize({
		resource: 'email_sends_per_day',
		day,
		count: 0,
		updatedAt: now.toISOString(),
	})
	await expect(
		meterA.consume({
			resource: 'email_sends_per_day',
			day,
			limit: sendLimit,
			updatedAt: now.toISOString(),
		}),
	).resolves.toMatchObject({
		outcome: 'ready',
		consumed: true,
		count: 1,
	})

	await consumeDailyEntitlement({
		db: env.APP_DB,
		env,
		userId: userA.userId,
		email: userA.email,
		resource: 'email_sends_per_day',
		now,
		waitUntil: drain.waitUntil,
	})
	await drain.drain()
	expect(
		await meterA.read({ resource: 'email_sends_per_day', day }),
	).toMatchObject({ outcome: 'ready', count: 2 })

	for (let index = 2; index < sendLimit; index += 1) {
		await consumeDailyEntitlement({
			db: env.APP_DB,
			env,
			userId: userA.userId,
			email: userA.email,
			resource: 'email_sends_per_day',
			now,
			waitUntil: drain.waitUntil,
		})
	}
	const concurrent = await Promise.all(
		Array.from({ length: 8 }, async () =>
			consumeDailyEntitlement({
				db: env.APP_DB,
				env,
				userId: userA.userId,
				email: userA.email,
				resource: 'email_sends_per_day',
				now,
				waitUntil: drain.waitUntil,
			}).then(
				() => null,
				(thrown: unknown) => thrown,
			),
		),
	)
	expect(concurrent.filter((result) => result === null)).toHaveLength(0)
	const denials = concurrent.filter(
		(result) => result instanceof EntitlementLimitError,
	)
	expect(denials).toHaveLength(8)
	for (const denial of denials) {
		expect(denial).toMatchObject({
			details: {
				code: 'entitlement_limit_exceeded',
				resource: 'email_sends_per_day',
				plan: 'free',
				limit: sendLimit,
				current: sendLimit,
			},
		})
	}

	await consumeDailyEntitlement({
		db: env.APP_DB,
		env,
		userId: userB.userId,
		email: userB.email,
		resource: 'email_sends_per_day',
		now,
		waitUntil: drain.waitUntil,
	})
	expect(
		await meterB.read({ resource: 'email_sends_per_day', day }),
	).toMatchObject({ outcome: 'ready', count: 1 })
	expect(
		await meterA.read({ resource: 'email_sends_per_day', day }),
	).toMatchObject({ outcome: 'ready', count: sendLimit })

	await refundDailyEntitlement({
		db: env.APP_DB,
		env,
		userId: userA.userId,
		resource: 'email_sends_per_day',
		now,
		waitUntil: drain.waitUntil,
	})
	expect(
		await meterA.read({ resource: 'email_sends_per_day', day }),
	).toMatchObject({ outcome: 'ready', count: sendLimit - 1 })
	for (let index = 0; index < sendLimit; index += 1) {
		await refundDailyEntitlement({
			db: env.APP_DB,
			env,
			userId: userA.userId,
			resource: 'email_sends_per_day',
			now,
			waitUntil: drain.waitUntil,
		})
	}
	expect(
		await meterA.read({ resource: 'email_sends_per_day', day }),
	).toMatchObject({ outcome: 'ready', count: 0 })

	await consumeDailyEntitlement({
		db: env.APP_DB,
		env,
		userId: userA.userId,
		email: userA.email,
		resource: 'email_sends_per_day',
		now,
		waitUntil: drain.waitUntil,
	})
	await consumeDailyEntitlement({
		db: env.APP_DB,
		env,
		userId: userA.userId,
		email: userA.email,
		resource: 'execute_calls_per_day',
		now,
		waitUntil: drain.waitUntil,
	})
	const exportedA = await meterA.exportCounters({})
	expect(exportedA.counters).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				resource: 'email_sends_per_day',
				day,
				count: 1,
			}),
			expect.objectContaining({
				resource: 'execute_calls_per_day',
				day,
				count: 1,
			}),
		]),
	)

	const [purgeResult, readDuringPurge, exportDuringPurge] = await Promise.all([
		meterA.purge(),
		meterA.read({ resource: 'email_sends_per_day', day }).then(
			(value) => value,
			(error: unknown) => error,
		),
		meterA.exportCounters({}).then(
			(value) => value,
			(error: unknown) => error,
		),
	])
	expect(purgeResult).toEqual({ ok: true })
	expect(readDuringPurge).not.toBeInstanceOf(Error)
	expect(exportDuringPurge).not.toBeInstanceOf(Error)
	expect(await meterA.read({ resource: 'email_sends_per_day', day })).toEqual({
		outcome: 'needs_bootstrap',
	})
	expect(await meterA.exportCounters({})).toEqual({
		counters: [],
		storageBytesShadow: null,
		nextStartAfter: null,
		truncated: false,
	})
	expect(
		await meterB.read({ resource: 'email_sends_per_day', day }),
	).toMatchObject({ outcome: 'ready', count: 1 })

	await env.APP_DB.prepare(
		`DELETE FROM entitlement_daily_counters
		WHERE user_id = ? AND resource = ? AND day = ?`,
	)
		.bind(userA.userId, 'email_sends_per_day', day)
		.run()

	consoleWarn.mockImplementation(() => {})
	const failingMirrorDb = {
		prepare(query: string) {
			if (
				query.includes('INSERT INTO entitlement_daily_counters') &&
				query.includes('updated_at < excluded.updated_at')
			) {
				return {
					bind() {
						return {
							async run() {
								throw new Error('mirror write failed')
							},
						}
					},
				}
			}
			return env.APP_DB.prepare(query)
		},
	} as unknown as D1Database

	await expect(
		consumeDailyEntitlement({
			db: failingMirrorDb,
			env,
			userId: userA.userId,
			email: userA.email,
			resource: 'email_sends_per_day',
			now,
			waitUntil: drain.waitUntil,
		}),
	).resolves.toBeUndefined()
	await drain.drain()
	expect(
		await meterA.read({ resource: 'email_sends_per_day', day }),
	).toMatchObject({ outcome: 'ready', count: 1 })
	expect(consoleWarn).toHaveBeenCalledWith(
		'entitlement-daily-mirror-failed',
		expect.any(Error),
	)
}, 30_000)

test('UserMeter consume rejects invalid UTC day keys before SQL', async () => {
	const user = await seedFreeUser('meter-invalid-day')
	const stub = env.USER_METER.get(
		env.USER_METER.idFromName(userMeterDurableObjectName(user.userId)),
	)
	await runInDurableObject(stub, async (instance: UserMeter) => {
		await expect(
			instance.consume({
				resource: 'email_sends_per_day',
				day: 'not-a-day',
				limit: 1,
				updatedAt: '2026-07-31T15:00:00.000Z',
			}),
		).rejects.toThrow(/UTC YYYY-MM-DD/)
	})
}, 30_000)

test('UserMeter purge blocks concurrent RPCs across deleteAll and schema restore', async () => {
	const now = new Date('2026-07-31T15:00:00.000Z')
	const day = utcDayKey(now)
	const user = await seedFreeUser('meter-purge-concurrency')
	const meter = userMeterRpc({ env, userId: user.userId })
	await meter.initialize({
		resource: 'email_sends_per_day',
		day,
		count: 4,
		updatedAt: now.toISOString(),
	})

	const stub = env.USER_METER.get(
		env.USER_METER.idFromName(userMeterDurableObjectName(user.userId)),
	)
	let releaseDelete: (() => void) | undefined
	const deletePaused = new Promise<void>((resolve) => {
		releaseDelete = resolve
	})
	let deleteAllReached = false
	await runInDurableObject(stub, async (instance: UserMeter, state) => {
		expect(instance).toBeInstanceOf(UserMeter)
		const originalDeleteAll = state.storage.deleteAll.bind(state.storage)
		state.storage.deleteAll = async () => {
			await originalDeleteAll()
			deleteAllReached = true
			await deletePaused
		}
	})

	const purgePromise = meter.purge()
	await waitFor(() => deleteAllReached, 5_000, 'purge deleteAll')

	const readPromise = meter.read({ resource: 'email_sends_per_day', day }).then(
		(value) => value,
		(error: unknown) => error,
	)
	const exportPromise = meter.exportCounters({}).then(
		(value) => value,
		(error: unknown) => error,
	)
	// Give queued RPCs a chance to enter the wiped-schema window if
	// blockConcurrencyWhile is missing around deleteAll+initializeSchema.
	await new Promise((resolve) => setTimeout(resolve, 25))
	releaseDelete!()

	const [purgeResult, readDuringPurge, exportDuringPurge] = await Promise.all([
		purgePromise,
		readPromise,
		exportPromise,
	])
	expect(purgeResult).toEqual({ ok: true })
	expect(readDuringPurge).toEqual({ outcome: 'needs_bootstrap' })
	expect(exportDuringPurge).toEqual({
		counters: [],
		storageBytesShadow: null,
		nextStartAfter: null,
		truncated: false,
	})
	expect(await meter.read({ resource: 'email_sends_per_day', day })).toEqual({
		outcome: 'needs_bootstrap',
	})
}, 30_000)

test('storage bytes enforcement remains D1-authoritative even when env is passed', async () => {
	const user = await seedFreeUser('meter-storage-d1-authority')
	const drain = createWaitUntilDrain()
	const meter = userMeterRpc({ env, userId: user.userId })
	const storageLimit = planLimits.free.maxStorageBytes
	const legacyBytes = storageLimit - 10

	await env.APP_DB.prepare(
		`UPDATE users
		SET d1_storage_bytes = ?,
			d1_storage_bytes_updated_at = ?
		WHERE stable_user_id = ?`,
	)
		.bind(legacyBytes, '2026-07-31T12:00:00.000Z', user.userId)
		.run()

	await meter.setStorageBytes({
		bytes: storageLimit,
		updatedAt: '2026-07-31T11:00:00.000Z',
	})

	await assertWithinStorageBytesEntitlement({
		db: env.APP_DB,
		env,
		userId: user.userId,
		email: user.email,
		requested: 5,
		waitUntil: drain.waitUntil,
	})
	await expect(
		readUserD1StorageBytes({ db: env.APP_DB, userId: user.userId }),
	).resolves.toBe(legacyBytes + 5)

	const denied = await assertWithinStorageBytesEntitlement({
		db: env.APP_DB,
		env,
		userId: user.userId,
		email: user.email,
		requested: 6,
		waitUntil: drain.waitUntil,
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	expect(denied).toBeInstanceOf(EntitlementLimitError)
	expect(denied).toMatchObject({
		details: {
			resource: 'storage_bytes',
			plan: 'free',
			limit: storageLimit,
			current: legacyBytes + 5,
		},
	})
	await expect(
		readUserD1StorageBytes({ db: env.APP_DB, userId: user.userId }),
	).resolves.toBe(legacyBytes + 5)

	await drain.drain()
	expect(await meter.readStorageBytes()).toMatchObject({
		outcome: 'ready',
		bytes: legacyBytes + 5,
	})
}, 30_000)

test('UserMeter storage shadow failure cannot affect successful D1 reserves', async () => {
	const user = await seedFreeUser('meter-storage-shadow-fail')
	const drain = createWaitUntilDrain()
	const storageLimit = planLimits.free.maxStorageBytes

	await env.APP_DB.prepare(
		`UPDATE users
		SET d1_storage_bytes = ?,
			d1_storage_bytes_updated_at = ?
		WHERE stable_user_id = ?`,
	)
		.bind(storageLimit - 20, '2026-07-31T12:00:00.000Z', user.userId)
		.run()

	consoleWarn.mockImplementation(() => {})
	const failingMeterEnv = {
		USER_METER: {
			idFromName: env.USER_METER.idFromName.bind(env.USER_METER),
			get() {
				return {
					async setStorageBytes() {
						throw new Error('shadow write failed')
					},
				}
			},
		},
	} as unknown as typeof env

	await expect(
		assertWithinStorageBytesEntitlement({
			db: env.APP_DB,
			env: failingMeterEnv,
			userId: user.userId,
			email: user.email,
			requested: 5,
			waitUntil: drain.waitUntil,
		}),
	).resolves.toBeUndefined()
	await expect(
		readUserD1StorageBytes({ db: env.APP_DB, userId: user.userId }),
	).resolves.toBe(storageLimit - 15)
	await drain.drain()
	expect(consoleWarn).toHaveBeenCalledWith(
		'entitlement-storage-bytes-shadow-failed',
		expect.any(Error),
	)
}, 30_000)

test('concurrent D1 storage reserves cannot overshoot the plan limit', async () => {
	const user = await seedFreeUser('meter-storage-concurrent-d1')
	const limit = planLimits.free.maxStorageBytes
	await env.APP_DB.prepare(
		`UPDATE users
		SET d1_storage_bytes = ?,
			d1_storage_bytes_updated_at = ?
		WHERE stable_user_id = ?`,
	)
		.bind(limit - 10, '2026-07-31T15:00:00.000Z', user.userId)
		.run()

	const attempts = await Promise.all(
		Array.from({ length: 20 }, () =>
			assertWithinStorageBytesEntitlement({
				db: env.APP_DB,
				userId: user.userId,
				email: user.email,
				requested: 5,
			}).then(
				() => 'reserved' as const,
				(error: unknown) => error,
			),
		),
	)
	const reserved = attempts.filter((result) => result === 'reserved')
	const denied = attempts.filter(
		(result) => result instanceof EntitlementLimitError,
	)
	expect(reserved).toHaveLength(2)
	expect(denied).toHaveLength(18)
	await expect(
		readUserD1StorageBytes({ db: env.APP_DB, userId: user.userId }),
	).resolves.toBe(limit)
}, 30_000)

test('delayed UserMeter storage shadow re-reads latest D1 and cannot regress D1', async () => {
	const user = await seedFreeUser('meter-storage-shadow-latest')
	const drain = createWaitUntilDrain()
	const meter = userMeterRpc({ env, userId: user.userId })

	await env.APP_DB.prepare(
		`UPDATE users
		SET d1_storage_bytes = ?,
			d1_storage_bytes_updated_at = ?
		WHERE stable_user_id = ?`,
	)
		.bind(10, '2026-07-31T16:00:00.000Z', user.userId)
		.run()

	let releaseShadow!: () => void
	const shadowGate = new Promise<void>((resolve) => {
		releaseShadow = resolve
	})
	let shadowReads = 0
	using _patch = withPatchedDbPrepare(env.APP_DB, (originalPrepare) => {
		return ((query: string) => {
			const statement = originalPrepare(query)
			const isPointRead =
				query.includes('SELECT d1_storage_bytes AS bytes') &&
				query.includes('FROM users')
			const isReserve = query.includes(
				'SET d1_storage_bytes = d1_storage_bytes + ?',
			)
			const originalBind = statement.bind.bind(statement)
			return {
				bind(...params: Array<unknown>) {
					const bound = originalBind(...params)
					return {
						first: async <T>() => {
							if (isPointRead) {
								shadowReads += 1
								await shadowGate
							}
							return await bound.first<T>()
						},
						all: bound.all.bind(bound),
						raw: bound.raw?.bind(bound),
						run: bound.run.bind(bound),
					}
				},
			}
		}) as D1Database['prepare']
	})

	await assertWithinStorageBytesEntitlement({
		db: env.APP_DB,
		env,
		userId: user.userId,
		email: user.email,
		requested: 5,
		waitUntil: drain.waitUntil,
	})
	await assertWithinStorageBytesEntitlement({
		db: env.APP_DB,
		userId: user.userId,
		email: user.email,
		requested: 7,
	})
	releaseShadow()
	await drain.drain()
	expect(shadowReads).toBeGreaterThanOrEqual(1)
	await expect(
		readUserD1StorageBytes({ db: env.APP_DB, userId: user.userId }),
	).resolves.toBe(22)
	expect(await meter.readStorageBytes()).toMatchObject({
		outcome: 'ready',
		bytes: 22,
	})
}, 30_000)

test('UserMeter storage RPCs, export shadow field, and purge work additively', async () => {
	const user = await seedFreeUser('meter-storage-export-purge')
	const meter = userMeterRpc({ env, userId: user.userId })
	await meter.initializeStorageBytes({
		bytes: 42,
		updatedAt: '2026-07-31T17:00:00.000Z',
	})
	await meter.reserveStorageBytes({
		requested: 8,
		limit: 1_000,
		updatedAt: '2026-07-31T17:01:00.000Z',
	})
	await meter.setStorageBytes({
		bytes: 11,
		updatedAt: '2026-07-31T17:02:00.000Z',
	})

	const day = '2026-07-31'
	for (const resource of [
		'email_receives_per_day',
		'email_sends_per_day',
		'execute_calls_per_day',
		'outbound_fetches_per_day',
	] as const) {
		await meter.initialize({
			resource,
			day,
			count: 1,
			updatedAt: '2026-07-31T17:03:00.000Z',
		})
	}

	const firstPage = await meter.exportCounters({ pageSize: 2 })
	expect(firstPage.counters).toHaveLength(2)
	expect(firstPage.truncated).toBe(true)
	expect(firstPage.nextStartAfter).toEqual(expect.any(String))
	expect(firstPage.storageBytesShadow).toEqual({
		bytes: 11,
		revision: 3,
		updatedAt: '2026-07-31T17:02:00.000Z',
		mirrorUpdatedAt: userMeterMirrorUpdatedAtToken(3),
	})

	const secondPage = await meter.exportCounters({
		pageSize: 2,
		startAfter: firstPage.nextStartAfter,
	})
	expect(secondPage.counters).toHaveLength(2)
	expect(secondPage.truncated).toBe(false)
	expect(secondPage.nextStartAfter).toBeNull()
	expect(secondPage.storageBytesShadow).toBeNull()

	await expect(
		readUserD1StorageBytes({ db: env.APP_DB, userId: user.userId }),
	).resolves.toBe(0)

	await expect(meter.purge()).resolves.toEqual({ ok: true })
	expect(await meter.readStorageBytes()).toEqual({
		outcome: 'needs_bootstrap',
	})
	expect(await meter.exportCounters({})).toEqual({
		counters: [],
		storageBytesShadow: null,
		nextStartAfter: null,
		truncated: false,
	})
}, 30_000)

test('missing-user storage reserve preserves EntitlementLimitError semantics on D1 path', async () => {
	await ensureEntitlementTestSchema(env.APP_DB)
	const missingUserId = 'a'.repeat(64)
	const freeLimit = planLimits.free.maxStorageBytes

	await expect(
		assertWithinStorageBytesEntitlement({
			db: env.APP_DB,
			env,
			userId: missingUserId,
			email: null,
			requested: 1,
		}),
	).resolves.toBeUndefined()

	const denied = await assertWithinStorageBytesEntitlement({
		db: env.APP_DB,
		env,
		userId: missingUserId,
		email: null,
		requested: freeLimit + 1,
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	expect(denied).toBeInstanceOf(EntitlementLimitError)
	expect(denied).toMatchObject({
		details: {
			resource: 'storage_bytes',
			plan: 'free',
			limit: freeLimit,
			current: 0,
		},
	})
}, 30_000)
