import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, test, vi } from 'vitest'
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
	readDailyEntitlementResourceUsage,
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

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 5_000,
	label = 'condition',
) {
	await vi
		.waitFor(
			() => {
				expect(predicate()).toBe(true)
			},
			{ timeout: timeoutMs, interval: 1 },
		)
		.catch(() => {
			throw new Error(`Timed out waiting for ${label}.`)
		})
}

function accountWriteLeaseColumnNames(state: DurableObjectState) {
	return state.storage.sql
		.exec<{ name: string }>(`PRAGMA table_info(account_write_leases)`)
		.toArray()
		.map((row) => String(row.name))
}

test('fresh UserMeter schema v9 creates the final write-lease shape', async () => {
	const user = await seedFreeUser('meter-schema-v9-fresh')
	const stub = env.USER_METER.get(
		env.USER_METER.idFromName(userMeterDurableObjectName(user.userId)),
	)
	await runInDurableObject(stub, async (instance: UserMeter, state) => {
		expect(instance).toBeInstanceOf(UserMeter)
		const version = state.storage.sql
			.exec<{ value: number }>(
				`SELECT value FROM user_meter_meta
				WHERE key = 'schema_version' LIMIT 1`,
			)
			.toArray()[0]
		expect(Number(version?.value)).toBe(9)
		expect(accountWriteLeaseColumnNames(state)).toEqual([
			'token',
			'holder',
			'acquired_at',
			'pending_repair_id',
		])
	})
}, 30_000)

test('warm UserMeter schema v7 upgrades to v9 and preserves leases', async () => {
	const user = await seedFreeUser('meter-schema-v7-upgrade')
	const stub = env.USER_METER.get(
		env.USER_METER.idFromName(userMeterDurableObjectName(user.userId)),
	)
	await runInDurableObject(stub, async (instance: UserMeter, state) => {
		await state.storage.deleteAll()
		state.storage.sql.exec(`
			CREATE TABLE user_meter_meta (
				key TEXT PRIMARY KEY NOT NULL,
				value INTEGER NOT NULL
			);
			INSERT INTO user_meter_meta (key, value)
			VALUES ('schema_version', 7);
			CREATE TABLE account_write_leases (
				token TEXT PRIMARY KEY NOT NULL,
				holder TEXT NOT NULL,
				acquired_at TEXT NOT NULL,
				pending_repair_id TEXT,
				authority TEXT NOT NULL DEFAULT 'legacy'
			);
			CREATE INDEX idx_account_write_leases_authority_acquired_token
			ON account_write_leases (authority, acquired_at, token);
			INSERT INTO account_write_leases (
				token, holder, acquired_at, pending_repair_id, authority
			) VALUES (
				'warm-v7-token', 'warm-v7-holder',
				'2026-08-03T00:00:00.000Z', 'repair-v7', 'do'
			);
		`)

		const proto = Object.getPrototypeOf(instance) as {
			initializeSchema: () => void
		}
		proto.initializeSchema.call(instance)

		const version = state.storage.sql
			.exec<{ value: number }>(
				`SELECT value FROM user_meter_meta
				WHERE key = 'schema_version' LIMIT 1`,
			)
			.toArray()[0]
		expect(Number(version?.value)).toBe(9)
		expect(accountWriteLeaseColumnNames(state)).toEqual([
			'token',
			'holder',
			'acquired_at',
			'pending_repair_id',
		])
		expect(
			state.storage.sql
				.exec<{
					token: string
					holder: string
					acquired_at: string
					pending_repair_id: string | null
				}>(
					`SELECT token, holder, acquired_at, pending_repair_id
					FROM account_write_leases`,
				)
				.toArray(),
		).toEqual([
			{
				token: 'warm-v7-token',
				holder: 'warm-v7-holder',
				acquired_at: '2026-08-03T00:00:00.000Z',
				pending_repair_id: 'repair-v7',
			},
		])
		const legacyIndex = state.storage.sql
			.exec<{ name: string }>(
				`SELECT name FROM sqlite_master
				WHERE type = 'index'
					AND name = 'idx_account_write_leases_authority_acquired_token'`,
			)
			.toArray()
		expect(legacyIndex).toEqual([])
	})
}, 30_000)

test('cold daily consume initializes at zero without D1 prepare/run and first unit is 1', async () => {
	const now = new Date('2026-07-31T15:00:00.000Z')
	const day = utcDayKey(now)
	const user = await seedFreeUser('meter-cold-zero')
	const meter = userMeterRpc({ env, userId: user.userId })

	let dailyPrepareCalls = 0
	using _patch = withPatchedDbPrepare(env.APP_DB, (originalPrepare) => {
		return ((query: string) => {
			if (query.includes('entitlement_daily_counters')) dailyPrepareCalls += 1
			return originalPrepare(query)
		}) as D1Database['prepare']
	})

	expect(await meter.read({ resource: 'email_sends_per_day', day })).toEqual({
		outcome: 'needs_bootstrap',
	})

	await consumeDailyEntitlement({
		db: env.APP_DB,
		env,
		userId: user.userId,
		email: user.email,
		resource: 'email_sends_per_day',
		now,
	})
	expect(
		await meter.read({ resource: 'email_sends_per_day', day }),
	).toMatchObject({
		outcome: 'ready',
		count: 1,
	})
	expect(dailyPrepareCalls).toBe(0)
}, 30_000)

test('warm daily consume/read never prepares entitlement_daily_counters', async () => {
	const now = new Date('2026-07-31T15:00:00.000Z')
	const day = utcDayKey(now)
	const user = await seedFreeUser('meter-warm-no-d1')
	const meter = userMeterRpc({ env, userId: user.userId })
	await meter.initialize({
		resource: 'email_sends_per_day',
		day,
		count: 0,
		updatedAt: now.toISOString(),
	})

	let dailyPrepareCalls = 0
	using _patch = withPatchedDbPrepare(env.APP_DB, (originalPrepare) => {
		return ((query: string) => {
			if (query.includes('entitlement_daily_counters')) dailyPrepareCalls += 1
			return originalPrepare(query)
		}) as D1Database['prepare']
	})

	await consumeDailyEntitlement({
		db: env.APP_DB,
		env,
		userId: user.userId,
		email: user.email,
		resource: 'email_sends_per_day',
		now,
	})
	await expect(
		readDailyEntitlementResourceUsage({
			db: env.APP_DB,
			env,
			userId: user.userId,
			resource: 'email_sends_per_day',
			now,
		}),
	).resolves.toBe(1)
	expect(dailyPrepareCalls).toBe(0)
}, 30_000)

test('next UTC day cold consume starts at zero independently', async () => {
	const dayOne = new Date('2026-07-31T15:00:00.000Z')
	const dayTwo = new Date('2026-08-01T01:00:00.000Z')
	const user = await seedFreeUser('meter-next-day')
	const meter = userMeterRpc({ env, userId: user.userId })

	await consumeDailyEntitlement({
		db: env.APP_DB,
		env,
		userId: user.userId,
		email: user.email,
		resource: 'email_sends_per_day',
		now: dayOne,
	})
	expect(
		await meter.read({
			resource: 'email_sends_per_day',
			day: utcDayKey(dayOne),
		}),
	).toMatchObject({ outcome: 'ready', count: 1 })

	expect(
		await meter.read({
			resource: 'email_sends_per_day',
			day: utcDayKey(dayTwo),
			now: dayTwo.toISOString(),
		}),
	).toEqual({ outcome: 'needs_bootstrap' })

	let dailyPrepareCalls = 0
	using _patch = withPatchedDbPrepare(env.APP_DB, (originalPrepare) => {
		return ((query: string) => {
			if (query.includes('entitlement_daily_counters')) dailyPrepareCalls += 1
			return originalPrepare(query)
		}) as D1Database['prepare']
	})

	await consumeDailyEntitlement({
		db: env.APP_DB,
		env,
		userId: user.userId,
		email: user.email,
		resource: 'email_sends_per_day',
		now: dayTwo,
	})
	expect(
		await meter.read({
			resource: 'email_sends_per_day',
			day: utcDayKey(dayTwo),
		}),
	).toMatchObject({ outcome: 'ready', count: 1 })
	expect(dailyPrepareCalls).toBe(0)
}, 30_000)

test('UserMeter daily entitlement consume/refund/read/export/purge workflow is per-user without D1 daily table', async () => {
	const now = new Date('2026-07-31T15:00:00.000Z')
	const day = utcDayKey(now)
	const sendLimit = planLimits.free.maxEmailSendsPerDay
	const userA = await seedFreeUser('meter-a')
	const userB = await seedFreeUser('meter-b')
	const meterA = userMeterRpc({ env, userId: userA.userId })
	const meterB = userMeterRpc({ env, userId: userB.userId })

	expect(userMeterDurableObjectName(userA.userId)).toBe(userA.userId)

	let dailyPrepareCalls = 0
	using _patch = withPatchedDbPrepare(env.APP_DB, (originalPrepare) => {
		return ((query: string) => {
			if (query.includes('entitlement_daily_counters')) dailyPrepareCalls += 1
			return originalPrepare(query)
		}) as D1Database['prepare']
	})

	await consumeDailyEntitlement({
		db: env.APP_DB,
		env,
		userId: userA.userId,
		email: userA.email,
		resource: 'email_sends_per_day',
		now,
	})
	expect(
		await meterA.read({ resource: 'email_sends_per_day', day }),
	).toMatchObject({ outcome: 'ready', count: 1 })

	for (let index = 1; index < sendLimit; index += 1) {
		await consumeDailyEntitlement({
			db: env.APP_DB,
			env,
			userId: userA.userId,
			email: userA.email,
			resource: 'email_sends_per_day',
			now,
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

	await consumeDailyEntitlement({
		db: env.APP_DB,
		env,
		userId: userB.userId,
		email: userB.email,
		resource: 'email_sends_per_day',
		now,
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
	})
	await consumeDailyEntitlement({
		db: env.APP_DB,
		env,
		userId: userA.userId,
		email: userA.email,
		resource: 'execute_calls_per_day',
		now,
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
		storageBytesState: null,
		packageServiceStates: [],
		deletionState: {
			deletingAt: null,
			activeWriteLeaseCount: 0,
			writeLeases: [],
		},
		nextStartAfter: null,
		truncated: false,
	})
	expect(
		await meterB.read({ resource: 'email_sends_per_day', day }),
	).toMatchObject({ outcome: 'ready', count: 1 })

	await expect(
		consumeDailyEntitlement({
			db: env.APP_DB,
			env,
			userId: userA.userId,
			email: userA.email,
			resource: 'email_sends_per_day',
			now,
		}),
	).resolves.toBeUndefined()
	expect(
		await meterA.read({ resource: 'email_sends_per_day', day }),
	).toMatchObject({ outcome: 'ready', count: 1 })
	expect(dailyPrepareCalls).toBe(0)

	const stub = env.USER_METER.get(
		env.USER_METER.idFromName(userMeterDurableObjectName(userA.userId)),
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
		storageBytesState: null,
		packageServiceStates: [],
		deletionState: {
			deletingAt: null,
			activeWriteLeaseCount: 0,
			writeLeases: [],
		},
		nextStartAfter: null,
		truncated: false,
	})
	expect(await meter.read({ resource: 'email_sends_per_day', day })).toEqual({
		outcome: 'needs_bootstrap',
	})
}, 30_000)

test('storage bytes are UserMeter-authoritative: cold zero bootstrap, denial, concurrency, and missing-user semantics', async () => {
	const storageLimit = planLimits.free.maxStorageBytes

	// === Section 1: Cold zero bootstrap, reserve, and denial ===
	const user = await seedFreeUser('meter-storage-do-authority')
	const meter = userMeterRpc({ env, userId: user.userId })

	// Cold bootstrap: zero-initializes UserMeter, then reserves 5.
	await assertWithinStorageBytesEntitlement({
		db: env.APP_DB,
		env,
		userId: user.userId,
		email: user.email,
		requested: 5,
	})
	expect(await meter.readStorageBytes()).toMatchObject({
		outcome: 'ready',
		bytes: 5,
	})

	// Deny an over-limit request: 5 + (limit - 4) = limit + 1 > limit.
	const denied = await assertWithinStorageBytesEntitlement({
		db: env.APP_DB,
		env,
		userId: user.userId,
		email: user.email,
		requested: storageLimit - 4,
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
			current: 5,
		},
	})

	// === Section 2: Concurrent reservations (UserMeter atomicity) ===
	const concurrentUser = await seedFreeUser('meter-storage-concurrent-do')
	const concurrentMeter = userMeterRpc({ env, userId: concurrentUser.userId })
	await concurrentMeter.initializeStorageBytes({
		bytes: storageLimit - 10,
		updatedAt: '2026-07-31T15:00:00.000Z',
	})

	const attempts = await Promise.all(
		Array.from({ length: 20 }, () =>
			assertWithinStorageBytesEntitlement({
				db: env.APP_DB,
				env,
				userId: concurrentUser.userId,
				email: concurrentUser.email,
				requested: 5,
			}).then(
				() => 'reserved' as const,
				(error: unknown) => error,
			),
		),
	)
	const reserved = attempts.filter((result) => result === 'reserved')
	const concurrentDenied = attempts.filter(
		(result) => result instanceof EntitlementLimitError,
	)
	expect(reserved).toHaveLength(2)
	expect(concurrentDenied).toHaveLength(18)
	expect(await concurrentMeter.readStorageBytes()).toMatchObject({
		outcome: 'ready',
		bytes: storageLimit,
	})

	// === Section 3: Missing user (synthetic context, free-plan semantics) ===
	await ensureEntitlementTestSchema(env.APP_DB)
	const missingUserId = 'a'.repeat(64)
	await expect(
		assertWithinStorageBytesEntitlement({
			db: env.APP_DB,
			env,
			userId: missingUserId,
			email: null,
			requested: 1,
		}),
	).resolves.toBeUndefined()

	const missingDenied = await assertWithinStorageBytesEntitlement({
		db: env.APP_DB,
		env,
		userId: missingUserId,
		email: null,
		requested: storageLimit + 1,
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	expect(missingDenied).toBeInstanceOf(EntitlementLimitError)
	expect(missingDenied).toMatchObject({
		details: {
			resource: 'storage_bytes',
			plan: 'free',
			limit: storageLimit,
			current: 0,
		},
	})
}, 30_000)

test('UserMeter storage RPCs, authoritative export state, and purge work additively', async () => {
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
	expect(firstPage.storageBytesState).toEqual({
		bytes: 11,
		revision: 3,
		updatedAt: '2026-07-31T17:02:00.000Z',
		mirrorUpdatedAt: userMeterMirrorUpdatedAtToken(3),
	})
	expect(firstPage.packageServiceStates).toEqual([])
	expect(firstPage.deletionState).toEqual({
		deletingAt: null,
		activeWriteLeaseCount: 0,
		writeLeases: [],
	})

	const secondPage = await meter.exportCounters({
		pageSize: 2,
		startAfter: firstPage.nextStartAfter,
	})
	expect(secondPage.counters).toHaveLength(2)
	expect(secondPage.truncated).toBe(false)
	expect(secondPage.nextStartAfter).toBeNull()
	expect(secondPage.storageBytesState).toBeNull()
	expect(secondPage.packageServiceStates).toBeNull()
	expect(secondPage.deletionState).toBeNull()

	await expect(meter.purge()).resolves.toEqual({ ok: true })
	expect(await meter.readStorageBytes()).toEqual({
		outcome: 'needs_bootstrap',
	})
	expect(await meter.exportCounters({})).toEqual({
		counters: [],
		storageBytesState: null,
		packageServiceStates: [],
		deletionState: {
			deletingAt: null,
			activeWriteLeaseCount: 0,
			writeLeases: [],
		},
		nextStartAfter: null,
		truncated: false,
	})
}, 30_000)

test('UserMeter package-service states are monotonic, isolated, exportable, and purgeable', async () => {
	const userA = await seedFreeUser('meter-pkg-svc-a')
	const userB = await seedFreeUser('meter-pkg-svc-b')
	const meterA = userMeterRpc({ env, userId: userA.userId })
	const meterB = userMeterRpc({ env, userId: userB.userId })

	const created = await meterA.upsertPackageServiceState({
		packageId: 'pkg-1',
		serviceName: 'worker',
		status: 'running',
		mode: 'bounded',
		startedAt: '2026-08-01T10:00:00.000Z',
		sourceUpdatedAt: '2026-08-01T10:00:00.000Z',
	})
	expect(created).toMatchObject({
		applied: true,
		created: true,
		state: {
			packageId: 'pkg-1',
			serviceName: 'worker',
			status: 'running',
			mode: 'bounded',
			startedAt: '2026-08-01T10:00:00.000Z',
			sourceUpdatedAt: '2026-08-01T10:00:00.000Z',
			revision: 1,
		},
	})

	const heartbeat = await meterA.upsertPackageServiceState({
		packageId: 'pkg-1',
		serviceName: 'worker',
		status: 'running',
		mode: 'bounded',
		startedAt: '2026-08-01T10:00:00.000Z',
		sourceUpdatedAt: '2026-08-01T11:00:00.000Z',
	})
	expect(heartbeat).toMatchObject({
		applied: true,
		created: false,
		state: {
			status: 'running',
			sourceUpdatedAt: '2026-08-01T11:00:00.000Z',
			revision: 2,
		},
	})

	const stale = await meterA.upsertPackageServiceState({
		packageId: 'pkg-1',
		serviceName: 'worker',
		status: 'stopped',
		startedAt: null,
		sourceUpdatedAt: '2026-08-01T10:30:00.000Z',
	})
	expect(stale).toMatchObject({
		applied: false,
		created: false,
		state: {
			status: 'running',
			sourceUpdatedAt: '2026-08-01T11:00:00.000Z',
			revision: 2,
		},
	})

	await meterA.upsertPackageServiceState({
		packageId: 'pkg-2',
		serviceName: 'idle-svc',
		status: 'idle',
		sourceUpdatedAt: '2026-08-01T11:05:00.000Z',
	})
	await meterB.upsertPackageServiceState({
		packageId: 'pkg-1',
		serviceName: 'worker',
		status: 'running',
		startedAt: '2026-08-01T11:00:00.000Z',
		sourceUpdatedAt: '2026-08-01T11:00:00.000Z',
	})

	expect(
		await meterA.countRunningPackageServices({
			now: '2026-08-01T11:30:00.000Z',
		}),
	).toEqual({ count: 1 })
	expect(
		await meterA.countRunningPackageServices({
			now: '2026-08-01T11:30:00.000Z',
			mode: 'persistent',
		}),
	).toEqual({ count: 0 })
	expect(
		await meterA.countRunningPackageServices({
			now: '2026-08-01T11:30:00.000Z',
			excludeService: { packageId: 'pkg-1', serviceName: 'worker' },
		}),
	).toEqual({ count: 0 })

	const listed = await meterA.listPackageServiceStates({ pageSize: 1 })
	expect(listed.states).toHaveLength(1)
	expect(listed.truncated).toBe(true)
	expect(listed.nextStartAfter).toEqual(expect.any(String))
	const listedRest = await meterA.listPackageServiceStates({
		pageSize: 10,
		startAfter: listed.nextStartAfter,
	})
	expect(listedRest.states).toHaveLength(1)
	expect(listedRest.truncated).toBe(false)

	const bootstrap = await meterA.bootstrapPackageServiceStates({
		states: [
			{
				packageId: 'pkg-1',
				serviceName: 'worker',
				status: 'error',
				sourceUpdatedAt: '2026-08-01T10:00:00.000Z',
			},
			{
				packageId: 'pkg-3',
				serviceName: 'new',
				status: 'stopped',
				sourceUpdatedAt: '2026-08-01T12:00:00.000Z',
			},
		],
	})
	expect(bootstrap).toEqual({ applied: 1, skipped: 1 })

	const day = '2026-08-01'
	for (const resource of [
		'email_receives_per_day',
		'email_sends_per_day',
	] as const) {
		await meterA.initialize({
			resource,
			day,
			count: 1,
			updatedAt: '2026-08-01T12:00:00.000Z',
		})
	}

	const firstPage = await meterA.exportCounters({ pageSize: 1 })
	expect(firstPage.truncated).toBe(true)
	expect(firstPage.nextStartAfter).toEqual(expect.any(String))
	expect(firstPage.packageServiceStates).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				packageId: 'pkg-1',
				serviceName: 'worker',
				status: 'running',
				revision: 2,
			}),
			expect.objectContaining({
				packageId: 'pkg-2',
				serviceName: 'idle-svc',
				status: 'idle',
			}),
			expect.objectContaining({
				packageId: 'pkg-3',
				serviceName: 'new',
				status: 'stopped',
			}),
		]),
	)
	const secondPage = await meterA.exportCounters({
		pageSize: 1,
		startAfter: firstPage.nextStartAfter,
	})
	expect(secondPage.packageServiceStates).toBeNull()
	expect(secondPage.deletionState).toBeNull()

	await expect(
		meterA.deletePackageServiceState({
			packageId: 'pkg-1',
			serviceName: 'worker',
		}),
	).resolves.toEqual({ deleted: true })
	expect(
		await meterA.countRunningPackageServices({
			now: '2026-08-01T11:30:00.000Z',
		}),
	).toEqual({ count: 0 })

	const stub = env.USER_METER.get(
		env.USER_METER.idFromName(userMeterDurableObjectName(userA.userId)),
	)
	const validIso = '2026-08-01T10:00:00.000Z'
	await expect(
		meterA.upsertPackageServiceState({
			packageId: 'pkg-iso',
			serviceName: 'worker',
			status: 'running',
			startedAt: validIso,
			sourceUpdatedAt: validIso,
		}),
	).resolves.toMatchObject({
		applied: true,
		state: { sourceUpdatedAt: validIso },
	})
	const rejected = [
		'',
		'not-a-timestamp',
		'2026-08-01T10:00:00Z',
		'2026-08-01 10:00:00.000Z',
		'2026-08-01T10:00:00.000+02:00',
		'2026-08-01T08:00:00.000+00:00',
		'2026-13-01T00:00:00.000Z',
		'2026-02-30T00:00:00.000Z',
	] as const
	await runInDurableObject(stub, async (instance: UserMeter) => {
		for (const sourceUpdatedAt of rejected) {
			await expect(
				instance.upsertPackageServiceState({
					packageId: 'pkg-iso',
					serviceName: 'worker',
					status: 'stopped',
					startedAt: null,
					sourceUpdatedAt,
				}),
			).rejects.toThrow(/ISO-8601 UTC timestamp/)
		}
	})
	// Prior valid row must remain; rejected writes must not throw RangeError past RPC.
	expect(await meterA.listPackageServiceStates({})).toMatchObject({
		states: expect.arrayContaining([
			expect.objectContaining({
				packageId: 'pkg-iso',
				status: 'running',
				sourceUpdatedAt: validIso,
			}),
		]),
	})

	await expect(meterA.purge()).resolves.toEqual({ ok: true })
	expect(await meterA.listPackageServiceStates({})).toEqual({
		states: [],
		nextStartAfter: null,
		truncated: false,
	})
	expect(await meterB.listPackageServiceStates({})).toMatchObject({
		states: [
			expect.objectContaining({
				packageId: 'pkg-1',
				serviceName: 'worker',
				status: 'running',
			}),
		],
	})
}, 30_000)

test('UserMeter deletion leases: mark, acquire, release, repair, export, and purge tombstone', async () => {
	const userA = await seedFreeUser('meter-deletion-a')
	const userB = await seedFreeUser('meter-deletion-b')
	const meterA = userMeterRpc({ env, userId: userA.userId })
	const meterB = userMeterRpc({ env, userId: userB.userId })

	// markDeleting preserves tombstone; repeated calls return the first timestamp.
	const firstMark = await meterA.markDeleting({
		deletingAt: '2026-08-01 10:00:00',
	})
	expect(firstMark).toEqual({
		deletingAt: '2026-08-01 10:00:00',
		created: true,
		leaseCount: 0,
	})
	const secondMark = await meterA.markDeleting({
		deletingAt: '2026-08-01 11:00:00',
	})
	expect(secondMark).toEqual({
		deletingAt: '2026-08-01 10:00:00',
		created: false,
		leaseCount: 0,
	})

	// acquireWriteLease is idempotent (same token).
	await expect(
		meterB.acquireWriteLease({
			token: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
			holder: 'test:writer-1',
			acquiredAt: '2026-08-01 10:05:00',
		}),
	).resolves.toEqual({ acquired: true })
	await expect(
		meterB.acquireWriteLease({
			token: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
			holder: 'test:writer-1',
			acquiredAt: '2026-08-01 10:05:00',
		}),
	).resolves.toEqual({ acquired: true })
	await expect(
		meterB.acquireWriteLease({
			token: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
			holder: 'test:writer-2',
			acquiredAt: '2026-08-01 10:06:00',
		}),
	).resolves.toEqual({ acquired: true })
	expect(await meterB.countActiveWriteLeases()).toEqual({ count: 2 })

	// listWriteLeases is paged and returns entries without authority field.
	const listed = await meterB.listWriteLeases({ pageSize: 1 })
	expect(listed.leases).toHaveLength(1)
	expect(listed.truncated).toBe(true)
	expect(listed.leases[0]).toEqual(
		expect.objectContaining({ token: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
	)
	const listedRest = await meterB.listWriteLeases({
		pageSize: 10,
		startAfter: listed.nextStartAfter,
	})
	expect(listedRest.leases).toHaveLength(1)
	expect(listedRest.truncated).toBe(false)
	expect(listedRest.leases[0]).toEqual(
		expect.objectContaining({ token: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
	)

	// releaseWriteLease removes the row.
	await expect(
		meterB.releaseWriteLease({
			token: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
		}),
	).resolves.toEqual({ released: true })
	expect(await meterB.countActiveWriteLeases()).toEqual({ count: 1 })

	// Acquiring on a deleted account is blocked.
	await expect(
		meterA.acquireWriteLease({
			token: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
			holder: 'test:blocked',
			acquiredAt: '2026-08-01 10:07:00',
		}),
	).resolves.toEqual({ acquired: false })

	// Repair: prepare + finalize (idempotent).
	const prepared = await meterB.prepareWriteLeaseRepair({
		token: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
		expectedAcquiredAt: '2026-08-01 10:06:00',
	})
	expect(prepared).toEqual(
		expect.objectContaining({
			prepared: true,
			token: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
			acquiredAt: '2026-08-01 10:06:00',
		}),
	)
	const repairId =
		prepared.prepared === true ? prepared.repairId : 'missing-repair-id'
	await expect(
		meterB.prepareWriteLeaseRepair({
			token: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
			expectedAcquiredAt: '2026-08-01 10:06:00',
		}),
	).resolves.toEqual(expect.objectContaining({ prepared: true, repairId }))
	await expect(
		meterB.assertWriteLeaseHeld({
			token: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
		}),
	).resolves.toEqual({ held: true })
	await expect(
		meterB.finalizeWriteLeaseRepair({
			token: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
			repairId,
			expectedAcquiredAt: '2026-08-01 10:06:00',
		}),
	).resolves.toEqual({ finalized: true })
	await expect(
		meterB.assertWriteLeaseHeld({
			token: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
		}),
	).resolves.toEqual({ held: false })
	// Idempotent finalize: already gone, returns finalized: true.
	await expect(
		meterB.finalizeWriteLeaseRepair({
			token: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
			repairId,
			expectedAcquiredAt: '2026-08-01 10:06:00',
		}),
	).resolves.toEqual({ finalized: true })

	// Export: deletionState emitted on first page only.
	const day = '2026-08-01'
	for (const resource of [
		'email_receives_per_day',
		'email_sends_per_day',
	] as const) {
		await meterA.initialize({
			resource,
			day,
			count: 1,
			updatedAt: '2026-08-01T12:00:00.000Z',
		})
	}
	const firstPage = await meterA.exportCounters({ pageSize: 1 })
	expect(firstPage.truncated).toBe(true)
	expect(firstPage.deletionState).toEqual({
		deletingAt: '2026-08-01 10:00:00',
		activeWriteLeaseCount: 0,
		writeLeases: [],
	})
	const secondPage = await meterA.exportCounters({
		pageSize: 1,
		startAfter: firstPage.nextStartAfter,
	})
	expect(secondPage.deletionState).toBeNull()

	// Purge resets counters but preserves the deletion tombstone.
	await expect(meterA.purge()).resolves.toEqual({ ok: true })
	expect(await meterA.readDeletionState()).toEqual({
		deletingAt: '2026-08-01 10:00:00',
	})
	expect(await meterA.countActiveWriteLeases()).toEqual({ count: 0 })
	expect(await meterA.read({ resource: 'email_sends_per_day', day })).toEqual({
		outcome: 'needs_bootstrap',
	})
	expect(await meterA.exportCounters({})).toEqual({
		counters: [],
		storageBytesState: null,
		packageServiceStates: [],
		deletionState: {
			deletingAt: '2026-08-01 10:00:00',
			activeWriteLeaseCount: 0,
			writeLeases: [],
		},
		nextStartAfter: null,
		truncated: false,
	})
	await expect(
		meterA.acquireWriteLease({
			token: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
			holder: 'test:post-purge',
			acquiredAt: '2026-08-01 13:00:00',
		}),
	).resolves.toEqual({ acquired: false })

	expect(await meterB.readDeletionState()).toEqual({ deletingAt: null })
	await expect(
		meterB.markDeleting({
			deletingAt: '2026-08-01 15:00:00',
		}),
	).resolves.toEqual({
		deletingAt: '2026-08-01 15:00:00',
		created: true,
		leaseCount: 0,
	})
	expect(await meterB.countActiveWriteLeases()).toEqual({ count: 0 })
}, 30_000)
