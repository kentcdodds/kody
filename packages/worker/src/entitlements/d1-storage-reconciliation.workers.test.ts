import { env } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { ensureEmailTestSchema } from '#worker/email/test-schema.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	calculateUserD1StorageBytes,
	readUserD1StorageBytes,
	reconcileUserD1StorageBytes,
} from './service.ts'
import { reconcileD1StorageBytes } from './d1-storage-reconciliation.ts'
import { userMeterRpc } from './user-meter-client.ts'

async function insertReconciliationUser(input: {
	userId: string
	email: string
	storedBytes: number
	updatedAt: string
}) {
	await env.APP_DB.prepare(
		`INSERT INTO users (
			username, email, password_hash, stable_user_id,
			d1_storage_bytes, d1_storage_bytes_updated_at
		) VALUES (?, ?, 'test-password', ?, ?, ?)`,
	)
		.bind(
			`d1-reconcile-${crypto.randomUUID().slice(0, 8)}`,
			input.email,
			input.userId,
			input.storedBytes,
			input.updatedAt,
		)
		.run()
}

async function insertTrackedD1Payload(userId: string, size: number) {
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS mcp_memories (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			category TEXT,
			subject TEXT,
			summary TEXT,
			details TEXT,
			tags_json TEXT,
			source_uris_json TEXT,
			dedupe_key TEXT
		)`,
	).run()
	await env.APP_DB.prepare(
		`INSERT INTO mcp_memories (id, user_id, subject, summary, details)
		VALUES (?, ?, 'storage reconciliation', 'tracked payload', ?)`,
	)
		.bind(crypto.randomUUID(), userId, 'x'.repeat(size))
		.run()
}

test('D1 storage reconciliation is UserMeter-authoritative: sets DO absolute first, then mirrors to D1', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await env.APP_DB.prepare(
		`UPDATE users
		SET d1_storage_bytes_updated_at = '9999-12-31T23:59:59.999Z'`,
	).run()

	const firstUserId = '1'.repeat(64)
	const secondUserId = '2'.repeat(64)
	await insertReconciliationUser({
		userId: firstUserId,
		email: `${crypto.randomUUID()}@example.test`,
		storedBytes: 1,
		updatedAt: '2020-01-01T00:00:00.000Z',
	})
	await insertReconciliationUser({
		userId: secondUserId,
		email: `${crypto.randomUUID()}@example.test`,
		storedBytes: 99,
		updatedAt: '2021-01-01T00:00:00.000Z',
	})
	await insertTrackedD1Payload(firstUserId, 256)

	const expectedFirstBytes = await calculateUserD1StorageBytes({
		db: env.APP_DB,
		userId: firstUserId,
	})
	expect(expectedFirstBytes).toBeGreaterThan(128)

	const firstMeter = userMeterRpc({ env, userId: firstUserId })
	expect(await firstMeter.readStorageBytes()).toEqual({
		outcome: 'needs_bootstrap',
	})

	// Reconcile first user: UserMeter should be set authoritative, D1 mirrored.
	await expect(
		reconcileD1StorageBytes({
			db: env.APP_DB,
			env,
			now: new Date('2026-07-31T01:00:00.000Z'),
			batchSize: 1,
		}),
	).resolves.toEqual({ scanned: 1, updated: 1, failed: 0, deferred: 0 })

	// D1 mirror reflects the physical recomputation.
	await expect(
		readUserD1StorageBytes({ db: env.APP_DB, userId: firstUserId }),
	).resolves.toBe(expectedFirstBytes)

	// UserMeter is now authoritative with the same physical value.
	expect(await firstMeter.readStorageBytes()).toMatchObject({
		outcome: 'ready',
		bytes: expectedFirstBytes,
	})

	// Second user (no tracked payload): reconcile zeros both.
	await expect(
		readUserD1StorageBytes({ db: env.APP_DB, userId: secondUserId }),
	).resolves.toBe(99)
	await expect(
		reconcileD1StorageBytes({
			db: env.APP_DB,
			env,
			now: new Date('2026-07-31T01:05:00.000Z'),
			batchSize: 1,
		}),
	).resolves.toEqual({ scanned: 1, updated: 1, failed: 0, deferred: 0 })
	await expect(
		readUserD1StorageBytes({ db: env.APP_DB, userId: secondUserId }),
	).resolves.toBe(0)
	const secondMeter = userMeterRpc({ env, userId: secondUserId })
	expect(await secondMeter.readStorageBytes()).toMatchObject({
		outcome: 'ready',
		bytes: 0,
	})
})

test('reconciliation sets UserMeter to physical-payload absolute, not stale D1 users counter', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await env.APP_DB.prepare(
		`UPDATE users
		SET d1_storage_bytes_updated_at = '9999-12-31T23:59:59.999Z'`,
	).run()

	const userId = '5'.repeat(64)
	// Stale D1 counter: 999_999. DO has a different, prior value.
	await insertReconciliationUser({
		userId,
		email: `${crypto.randomUUID()}@example.test`,
		storedBytes: 999_999,
		updatedAt: '2019-01-01T00:00:00.000Z',
	})
	await insertTrackedD1Payload(userId, 256)

	// Pre-set UserMeter to a large stale value that physical recompute should replace.
	const meter = userMeterRpc({ env, userId })
	await meter.setStorageBytes({
		bytes: 500_000,
		updatedAt: '2026-07-31T00:00:00.000Z',
	})

	const expectedBytes = await calculateUserD1StorageBytes({
		db: env.APP_DB,
		userId,
	})

	await expect(
		reconcileD1StorageBytes({
			db: env.APP_DB,
			env,
			now: new Date('2026-07-31T01:00:00.000Z'),
			batchSize: 8,
		}),
	).resolves.toMatchObject({ failed: 0 })

	// UserMeter should now equal the physical payload recomputation, NOT the stale DO
	// value or stale D1 counter (both 500_000 / 999_999 must have been corrected).
	await expect(
		readUserD1StorageBytes({ db: env.APP_DB, userId }),
	).resolves.toBe(expectedBytes)
	expect(await meter.readStorageBytes()).toMatchObject({
		outcome: 'ready',
		bytes: expectedBytes,
	})
	expect(expectedBytes).not.toBe(500_000)
	expect(expectedBytes).not.toBe(999_999)

	await env.APP_DB.prepare(
		`UPDATE users
		SET d1_storage_bytes_updated_at = '9999-12-31T23:59:59.999Z'`,
	).run()
})

test('reconciliation row failure is isolated: UserMeter set failure counts as failed, moves to back of queue', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await env.APP_DB.prepare(
		`UPDATE users
		SET d1_storage_bytes_updated_at = '9999-12-31T23:59:59.999Z'`,
	).run()

	const failingUserId = '6'.repeat(64)
	await insertReconciliationUser({
		userId: failingUserId,
		email: `${crypto.randomUUID()}@example.test`,
		storedBytes: 40,
		updatedAt: '2018-01-01T00:00:00.000Z',
	})

	// Env where reconcileStorageBytes throws — simulates UserMeter failure.
	const failingMeterEnv = {
		USER_METER: {
			idFromName: env.USER_METER.idFromName.bind(env.USER_METER),
			get() {
				return {
					async readStorageBytes() {
						return { outcome: 'needs_bootstrap' as const }
					},
					async initializeStorageBytes() {
						throw new Error('UserMeter reconcile failed')
					},
				}
			},
		},
	} as unknown as typeof env

	consoleWarn.mockImplementation(() => {})
	await expect(
		reconcileD1StorageBytes({
			db: env.APP_DB,
			env: failingMeterEnv,
			now: new Date('2026-07-31T01:15:00.000Z'),
			batchSize: 1,
		}),
	).resolves.toEqual({ scanned: 1, updated: 0, failed: 1, deferred: 0 })

	expect(consoleWarn).toHaveBeenCalledWith(
		'd1-storage-reconciliation-row-failed',
		failingUserId,
		expect.any(Error),
	)

	await env.APP_DB.prepare(
		`UPDATE users
		SET d1_storage_bytes_updated_at = '9999-12-31T23:59:59.999Z'`,
	).run()
})

test('reconcile defers and preserves reserve when CAS misses a concurrent reservation between revision capture and CAS', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await env.APP_DB.prepare(
		`UPDATE users
		SET d1_storage_bytes_updated_at = '9999-12-31T23:59:59.999Z'`,
	).run()

	const userId = '7'.repeat(64)
	await insertReconciliationUser({
		userId,
		email: `${crypto.randomUUID()}@example.test`,
		storedBytes: 0,
		updatedAt: '2019-01-01T00:00:00.000Z',
	})
	// Seed physical bytes in D1 so calculateUserD1StorageBytes > 0.
	await insertTrackedD1Payload(userId, 256)

	const meter = userMeterRpc({ env, userId })
	// Seed DO at revision=1 with 100 bytes.
	await meter.initializeStorageBytes({
		bytes: 100,
		updatedAt: '2026-08-01T00:00:00.000Z',
	})

	const physicalBytes = await calculateUserD1StorageBytes({
		db: env.APP_DB,
		userId,
	})
	expect(physicalBytes).toBeGreaterThan(0)

	// Wrap the real meter: readStorageBytes forwards to the real DO; reconcileStorageBytes
	// first does a concurrent reserve on the real DO (bumping revision 1→2), then
	// calls the real CAS with the stale expectedRevision so it naturally misses.
	const concurrentMeterEnv = {
		USER_METER: {
			idFromName: env.USER_METER.idFromName.bind(env.USER_METER),
			get() {
				return {
					async readStorageBytes() {
						return meter.readStorageBytes()
					},
					async reconcileStorageBytes(input: {
						bytes: number
						expectedRevision: number
						updatedAt: string
					}) {
						// Inject concurrent reserve between revision capture and CAS.
						const reserved = await meter.reserveStorageBytes({
							requested: 50,
							limit: 1_000_000,
							updatedAt: '2026-08-01T00:00:02.000Z',
						})
						expect(reserved).toMatchObject({
							reserved: true,
							revision: 2,
							bytes: 150,
						})
						// Forward CAS with the stale expectedRevision — will miss because
						// the real DO is now at revision=2.
						return meter.reconcileStorageBytes(input)
					},
				}
			},
		},
	} as unknown as typeof env

	const result = await reconcileUserD1StorageBytes({
		db: env.APP_DB,
		env: concurrentMeterEnv,
		userId,
		now: new Date('2026-08-01T01:00:00.000Z'),
	})

	// Reconcile reports deferred; reserve not clobbered.
	expect(result).toEqual({
		bytes: physicalBytes,
		updated: false,
		deferred: true,
	})

	// Real DO still has 150 bytes (initial 100 + reserve 50).
	expect(await meter.readStorageBytes()).toMatchObject({ bytes: 150 })

	// D1 mirror NOT updated — reconcile never reached the mirror step.
	await expect(
		readUserD1StorageBytes({ db: env.APP_DB, userId }),
	).resolves.toBe(0)

	await env.APP_DB.prepare(
		`UPDATE users
		SET d1_storage_bytes_updated_at = '9999-12-31T23:59:59.999Z'`,
	).run()
})

test('reconcile applies successful downward correction and mirrors D1', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await env.APP_DB.prepare(
		`UPDATE users
		SET d1_storage_bytes_updated_at = '9999-12-31T23:59:59.999Z'`,
	).run()

	const userId = '8'.repeat(64)
	await insertReconciliationUser({
		userId,
		email: `${crypto.randomUUID()}@example.test`,
		storedBytes: 0,
		updatedAt: '2019-01-01T00:00:00.000Z',
	})
	// Seed physical bytes in D1.
	await insertTrackedD1Payload(userId, 256)

	// Seed DO with a large stale value that reconciliation should correct downward.
	const meter = userMeterRpc({ env, userId })
	await meter.setStorageBytes({
		bytes: 500_000,
		updatedAt: '2026-08-01T00:00:00.000Z',
	})

	const physicalBytes = await calculateUserD1StorageBytes({
		db: env.APP_DB,
		userId,
	})
	expect(physicalBytes).toBeGreaterThan(0)
	expect(physicalBytes).toBeLessThan(500_000)

	const result = await reconcileUserD1StorageBytes({
		db: env.APP_DB,
		env,
		userId,
		now: new Date('2026-08-01T01:00:00.000Z'),
	})

	// CAS applied; DO corrected to physical bytes; D1 mirrored.
	expect(result).toEqual({
		bytes: physicalBytes,
		updated: true,
		deferred: false,
	})
	expect(await meter.readStorageBytes()).toMatchObject({ bytes: physicalBytes })
	await expect(
		readUserD1StorageBytes({ db: env.APP_DB, userId }),
	).resolves.toBe(physicalBytes)

	await env.APP_DB.prepare(
		`UPDATE users
		SET d1_storage_bytes_updated_at = '9999-12-31T23:59:59.999Z'`,
	).run()
})

test('reconcile defers without overwriting when cold init race: another caller created meter state first', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await env.APP_DB.prepare(
		`UPDATE users
		SET d1_storage_bytes_updated_at = '9999-12-31T23:59:59.999Z'`,
	).run()

	const userId = '9'.repeat(64)
	await insertReconciliationUser({
		userId,
		email: `${crypto.randomUUID()}@example.test`,
		storedBytes: 0,
		updatedAt: '2019-01-01T00:00:00.000Z',
	})
	// Seed physical bytes in D1.
	await insertTrackedD1Payload(userId, 256)

	const physicalBytes = await calculateUserD1StorageBytes({
		db: env.APP_DB,
		userId,
	})
	expect(physicalBytes).toBeGreaterThan(0)

	// Mock: meter always reports needs_bootstrap on read; initializeStorageBytes
	// reports created=false (simulating another concurrent caller created it first).
	let initCallCount = 0
	const raceEnv = {
		USER_METER: {
			idFromName: env.USER_METER.idFromName.bind(env.USER_METER),
			get() {
				return {
					async readStorageBytes() {
						return { outcome: 'needs_bootstrap' as const }
					},
					async initializeStorageBytes(_input: {
						bytes: number
						updatedAt: string
					}) {
						initCallCount++
						// Another concurrent reconcile/bootstrap caller already created the singleton.
						return {
							outcome: 'ready' as const,
							bytes: 999,
							revision: 3,
							mirrorUpdatedAt: 'r/00000000000000000003',
							created: false,
						}
					},
				}
			},
		},
	} as unknown as typeof env

	const result = await reconcileUserD1StorageBytes({
		db: env.APP_DB,
		env: raceEnv,
		userId,
		now: new Date('2026-08-01T01:00:00.000Z'),
	})

	// Deferred: init race detected; no overwrite of concurrent caller's state.
	expect(result).toEqual({
		bytes: physicalBytes,
		updated: false,
		deferred: true,
	})
	expect(initCallCount).toBe(1)

	// D1 mirror NOT updated — only mirrors after successful init or CAS.
	await expect(
		readUserD1StorageBytes({ db: env.APP_DB, userId }),
	).resolves.toBe(0)

	await env.APP_DB.prepare(
		`UPDATE users
		SET d1_storage_bytes_updated_at = '9999-12-31T23:59:59.999Z'`,
	).run()
})
