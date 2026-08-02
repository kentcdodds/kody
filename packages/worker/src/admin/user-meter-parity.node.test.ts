import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import {
	userMeterRpc,
	type UserMeterEnv,
} from '#worker/entitlements/user-meter-client.ts'
import {
	dailyEntitlementResources,
	type UserMeterPackageServiceState,
	type UserMeterWriteLeaseShadow,
} from '#worker/entitlements/user-meter-do.ts'
import { loadAdminUserMeterParityReport } from './user-meter-parity.ts'

const stableUserId = testStableUserIdFromEmail('parity@example.com')
const now = new Date('2026-08-01T12:00:00.000Z')
const day = utcDayKey(now)

function createParityTestDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE users (
			id INTEGER PRIMARY KEY,
			stable_user_id TEXT UNIQUE NOT NULL,
			username TEXT NOT NULL,
			email TEXT NOT NULL,
			password_hash TEXT,
			d1_storage_bytes INTEGER NOT NULL DEFAULT 0,
			deleting_at TEXT,
			active_write_count INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
			updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
		);
		CREATE TABLE entitlement_daily_counters (
			user_id TEXT NOT NULL,
			resource TEXT NOT NULL,
			day TEXT NOT NULL,
			count INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (user_id, resource, day)
		);
		CREATE TABLE package_service_states (
			user_id TEXT NOT NULL,
			package_id TEXT NOT NULL,
			service_name TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('running', 'idle', 'stopped', 'error')),
			started_at TEXT,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (user_id, package_id, service_name)
		);
		CREATE TABLE account_write_leases (
			token TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			holder TEXT NOT NULL,
			acquired_at TEXT NOT NULL,
			released_at TEXT
		);
	`)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function insertUser(
	sqlite: DatabaseSync,
	input: {
		stableUserId: string
		d1StorageBytes?: number
		deletingAt?: string | null
	},
) {
	sqlite
		.prepare(
			`INSERT INTO users (
				stable_user_id, username, email, d1_storage_bytes, deleting_at
			) VALUES (?, ?, ?, ?, ?)`,
		)
		.run(
			input.stableUserId,
			'parity-user',
			'parity@example.com',
			input.d1StorageBytes ?? 0,
			input.deletingAt ?? null,
		)
}

async function seedMeterParityBaseline(input: {
	meter: ReturnType<typeof createInMemoryUserMeterEnv>
	stableUserId: string
	dailyCounts: Record<(typeof dailyEntitlementResources)[number], number>
	storageBytes: number
	packageServices?: Array<{
		packageId: string
		serviceName: string
		status: 'running' | 'idle' | 'stopped' | 'error'
		startedAt?: string | null
		sourceUpdatedAt: string
	}>
	deletingAt?: string | null
	leases?: Array<{
		token: string
		holder: string
		acquiredAt: string
		authority: 'do' | 'legacy'
	}>
}) {
	const meter = userMeterRpc({
		env: input.meter.env,
		userId: input.stableUserId,
	})
	for (const resource of dailyEntitlementResources) {
		await meter.initialize({
			resource,
			day,
			count: input.dailyCounts[resource],
			updatedAt: now.toISOString(),
		})
	}
	await meter.initializeStorageBytes({
		bytes: input.storageBytes,
		updatedAt: now.toISOString(),
	})
	for (const service of input.packageServices ?? []) {
		await meter.upsertPackageServiceState({
			packageId: service.packageId,
			serviceName: service.serviceName,
			status: service.status,
			startedAt: service.startedAt ?? null,
			sourceUpdatedAt: service.sourceUpdatedAt,
			updatedAt: now.toISOString(),
		})
	}
	await meter.bootstrapDeletionState({
		deletingAt: input.deletingAt ?? null,
		leases: input.leases,
	})
}

function seedD1ParityBaseline(input: {
	sqlite: DatabaseSync
	stableUserId: string
	dailyCounts: Record<(typeof dailyEntitlementResources)[number], number>
	storageBytes: number
	packageServices?: Array<{
		packageId: string
		serviceName: string
		status: 'running' | 'idle' | 'stopped' | 'error'
		startedAt?: string | null
		updatedAt: string
	}>
	deletingAt?: string | null
	leases?: Array<{
		token: string
		holder: string
		acquiredAt: string
	}>
}) {
	insertUser(input.sqlite, {
		stableUserId: input.stableUserId,
		d1StorageBytes: input.storageBytes,
		deletingAt: input.deletingAt ?? null,
	})
	for (const resource of dailyEntitlementResources) {
		input.sqlite
			.prepare(
				`INSERT INTO entitlement_daily_counters (
					user_id, resource, day, count, updated_at
				) VALUES (?, ?, ?, ?, ?)`,
			)
			.run(
				input.stableUserId,
				resource,
				day,
				input.dailyCounts[resource],
				now.toISOString(),
			)
	}
	for (const service of input.packageServices ?? []) {
		input.sqlite
			.prepare(
				`INSERT INTO package_service_states (
					user_id, package_id, service_name, status, started_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.stableUserId,
				service.packageId,
				service.serviceName,
				service.status,
				service.status === 'running' ? (service.startedAt ?? null) : null,
				service.updatedAt,
			)
	}
	for (const lease of input.leases ?? []) {
		input.sqlite
			.prepare(
				`INSERT INTO account_write_leases (
					token, user_id, holder, acquired_at, released_at
				) VALUES (?, ?, ?, ?, NULL)`,
			)
			.run(lease.token, input.stableUserId, lease.holder, lease.acquiredAt)
	}
}

function assertNoLeaseSecrets(value: unknown) {
	const serialized = JSON.stringify(value)
	expect(serialized).not.toMatch(/lease-token|holder-secret|secret-holder/i)
	expect(serialized).not.toContain('"token"')
	expect(serialized).not.toContain('"holder"')
}

type MeterListPageInput = {
	pageSize?: number
	startAfter?: string | null
}

function withMeterListOverrides(
	meter: ReturnType<typeof createInMemoryUserMeterEnv>,
	overrides: {
		listPackageServiceStates?: (input: MeterListPageInput) => Promise<{
			states: Array<UserMeterPackageServiceState>
			nextStartAfter: string | null
			truncated: boolean
		}>
		listWriteLeases?: (input: MeterListPageInput) => Promise<{
			leases: Array<UserMeterWriteLeaseShadow>
			nextStartAfter: string | null
			truncated: boolean
		}>
	},
): UserMeterEnv {
	const namespace = meter.env.USER_METER
	if (!namespace) throw new Error('expected USER_METER binding')
	const originalGet = namespace.get.bind(namespace)
	return {
		USER_METER: {
			idFromName: namespace.idFromName.bind(namespace),
			get: (id: DurableObjectId) => {
				const stub = originalGet(id) as unknown as Record<string, unknown> & {
					listPackageServiceStates: (input: MeterListPageInput) => Promise<{
						states: Array<UserMeterPackageServiceState>
						nextStartAfter: string | null
						truncated: boolean
					}>
					listWriteLeases: (input: MeterListPageInput) => Promise<{
						leases: Array<UserMeterWriteLeaseShadow>
						nextStartAfter: string | null
						truncated: boolean
					}>
				}
				return {
					...stub,
					listPackageServiceStates:
						overrides.listPackageServiceStates ??
						stub.listPackageServiceStates.bind(stub),
					listWriteLeases:
						overrides.listWriteLeases ?? stub.listWriteLeases.bind(stub),
				}
			},
		},
	} as unknown as UserMeterEnv
}

test('loadAdminUserMeterParityReport reports full parity across daily/storage/services/deletion', async () => {
	const { sqlite, db } = createParityTestDb()
	const meter = createInMemoryUserMeterEnv()
	const dailyCounts = {
		email_sends_per_day: 3,
		email_receives_per_day: 5,
		execute_calls_per_day: 11,
		outbound_fetches_per_day: 7,
	}
	const serviceUpdatedAt = '2026-08-01T11:00:00.000Z'
	const leaseToken = 'lease-token-shared'
	seedD1ParityBaseline({
		sqlite,
		stableUserId,
		dailyCounts,
		storageBytes: 4096,
		packageServices: [
			{
				packageId: 'pkg-a',
				serviceName: 'web',
				status: 'running',
				startedAt: '2026-08-01T10:00:00.000Z',
				updatedAt: serviceUpdatedAt,
			},
		],
		leases: [
			{
				token: leaseToken,
				holder: 'holder-secret',
				acquiredAt: '2026-08-01T09:00:00.000Z',
			},
		],
	})
	await seedMeterParityBaseline({
		meter,
		stableUserId,
		dailyCounts,
		storageBytes: 4096,
		packageServices: [
			{
				packageId: 'pkg-a',
				serviceName: 'web',
				status: 'running',
				startedAt: '2026-08-01T10:00:00.000Z',
				sourceUpdatedAt: serviceUpdatedAt,
			},
		],
		leases: [
			{
				token: leaseToken,
				holder: 'holder-secret',
				acquiredAt: '2026-08-01T09:00:00.000Z',
				authority: 'do',
			},
		],
	})

	const report = await loadAdminUserMeterParityReport({
		db,
		env: meter.env,
		stableUserId,
		now,
	})
	expect(report).toMatchObject({
		generatedAt: now.toISOString(),
		stableUserId,
		daily: {
			day,
			mirrorRetired: false,
			mismatchCount: 0,
		},
		storage: {
			d1Bytes: 4096,
			meterBytes: 4096,
			needsBootstrap: false,
			delta: 0,
			parity: true,
		},
		packageServices: {
			d1Count: 1,
			meterCount: 1,
			truncated: false,
			mismatchCategories: {
				d1Only: 0,
				meterOnly: 0,
				statusMismatch: 0,
				startedAtMismatch: 0,
				sourceUpdatedAtMismatch: 0,
			},
			running: {
				d1FreshRunningCount: 1,
				meterRunningCount: 1,
				parity: true,
			},
			parity: true,
		},
		deletion: {
			d1DeletingAt: null,
			meterDeletingAt: null,
			deletingAtParity: true,
			d1ActiveLeaseCount: 1,
			doAuthorityLeaseCount: 1,
			doLegacyLeaseCount: 0,
			tokenSetMismatches: {
				d1Only: 0,
				doOnly: 0,
				legacyWithoutD1: 0,
			},
			truncated: false,
			temporaryMirrorRetired: true,
			mirrorLeaseParity: true,
		},
	})
	expect(report?.daily.resources).toHaveLength(4)
	expect(report?.daily.resources.every((row) => row.parity)).toBe(true)
	assertNoLeaseSecrets(report)
})

test('loadAdminUserMeterParityReport treats D1-only leases as mirrorLeaseParity pass', async () => {
	const { sqlite, db } = createParityTestDb()
	const meter = createInMemoryUserMeterEnv()
	const dailyCounts = {
		email_sends_per_day: 0,
		email_receives_per_day: 0,
		execute_calls_per_day: 0,
		outbound_fetches_per_day: 0,
	}
	seedD1ParityBaseline({
		sqlite,
		stableUserId,
		dailyCounts,
		storageBytes: 0,
		leases: [
			{
				token: 'lease-token-email-only',
				holder: 'holder-secret',
				acquiredAt: '2026-08-01T09:00:00.000Z',
			},
		],
	})
	await seedMeterParityBaseline({
		meter,
		stableUserId,
		dailyCounts,
		storageBytes: 0,
	})

	const report = await loadAdminUserMeterParityReport({
		db,
		env: meter.env,
		stableUserId,
		now,
	})
	expect(report?.deletion).toMatchObject({
		d1ActiveLeaseCount: 1,
		doAuthorityLeaseCount: 0,
		doLegacyLeaseCount: 0,
		tokenSetMismatches: {
			d1Only: 1,
			doOnly: 0,
			legacyWithoutD1: 0,
		},
		truncated: false,
		temporaryMirrorRetired: true,
		mirrorLeaseParity: true,
	})
	assertNoLeaseSecrets(report)
})

test('loadAdminUserMeterParityReport classifies mismatches and needsBootstrap without writing parity state', async () => {
	const { sqlite, db } = createParityTestDb()
	const meter = createInMemoryUserMeterEnv()
	insertUser(sqlite, { stableUserId, d1StorageBytes: 100 })
	sqlite
		.prepare(
			`INSERT INTO entitlement_daily_counters (
				user_id, resource, day, count, updated_at
			) VALUES (?, 'email_sends_per_day', ?, 9, ?)`,
		)
		.run(stableUserId, day, now.toISOString())
	sqlite
		.prepare(
			`INSERT INTO package_service_states (
				user_id, package_id, service_name, status, started_at, updated_at
			) VALUES (?, 'pkg-a', 'web', 'running', ?, ?)`,
		)
		.run(stableUserId, '2026-08-01T10:00:00.000Z', '2026-08-01T11:00:00.000Z')
	sqlite
		.prepare(
			`INSERT INTO account_write_leases (
				token, user_id, holder, acquired_at, released_at
			) VALUES ('d1-only-token', ?, 'holder-secret', ?, NULL)`,
		)
		.run(stableUserId, '2026-08-01T09:00:00.000Z')

	const meterStub = userMeterRpc({ env: meter.env, userId: stableUserId })
	await meterStub.initialize({
		resource: 'email_sends_per_day',
		day,
		count: 2,
		updatedAt: now.toISOString(),
	})
	await meterStub.upsertPackageServiceState({
		packageId: 'pkg-b',
		serviceName: 'worker',
		status: 'idle',
		sourceUpdatedAt: '2026-08-01T11:30:00.000Z',
	})
	await meterStub.bootstrapDeletionState({
		leases: [
			{
				token: 'do-only-token',
				holder: 'secret-holder',
				acquiredAt: '2026-08-01T08:00:00.000Z',
				authority: 'do',
			},
			{
				token: 'legacy-only-token',
				holder: 'secret-holder',
				acquiredAt: '2026-08-01T07:00:00.000Z',
				authority: 'legacy',
			},
		],
	})

	const beforeRead = await meterStub.read({
		resource: 'email_receives_per_day',
		day,
		now: now.toISOString(),
	})
	expect(beforeRead).toEqual({ outcome: 'needs_bootstrap' })

	const report = await loadAdminUserMeterParityReport({
		db,
		env: meter.env,
		stableUserId,
		now,
	})
	expect(report?.daily.mismatchCount).toBe(4)
	expect(
		report?.daily.resources.find(
			(row) => row.resource === 'email_sends_per_day',
		),
	).toMatchObject({
		d1Count: 9,
		meterCount: 2,
		needsBootstrap: false,
		delta: 7,
		parity: false,
	})
	expect(
		report?.daily.resources.find(
			(row) => row.resource === 'email_receives_per_day',
		),
	).toMatchObject({
		d1Count: 0,
		meterCount: null,
		needsBootstrap: true,
		delta: null,
		parity: false,
	})
	expect(report?.storage).toMatchObject({
		d1Bytes: 100,
		meterBytes: null,
		needsBootstrap: true,
		delta: null,
		parity: false,
	})
	expect(report?.packageServices).toMatchObject({
		d1Count: 1,
		meterCount: 1,
		mismatchCategories: {
			d1Only: 1,
			meterOnly: 1,
			statusMismatch: 0,
			startedAtMismatch: 0,
			sourceUpdatedAtMismatch: 0,
		},
		running: {
			d1FreshRunningCount: 1,
			meterRunningCount: 0,
			parity: false,
		},
		parity: false,
	})
	expect(report?.deletion).toMatchObject({
		d1ActiveLeaseCount: 1,
		doAuthorityLeaseCount: 1,
		doLegacyLeaseCount: 1,
		tokenSetMismatches: {
			d1Only: 1,
			doOnly: 1,
			legacyWithoutD1: 1,
		},
		temporaryMirrorRetired: true,
		mirrorLeaseParity: false,
	})

	const afterRead = await meterStub.read({
		resource: 'email_receives_per_day',
		day,
		now: now.toISOString(),
	})
	expect(afterRead).toEqual({ outcome: 'needs_bootstrap' })
	expect(await meterStub.readStorageBytes()).toEqual({
		outcome: 'needs_bootstrap',
	})
	assertNoLeaseSecrets(report)
})

test('loadAdminUserMeterParityReport doOnly passes mirrorLeaseParity after retirement; legacyWithoutD1 still fails', async () => {
	const { sqlite, db } = createParityTestDb()
	const meter = createInMemoryUserMeterEnv()
	insertUser(sqlite, { stableUserId, d1StorageBytes: 0 })
	const meterStub = userMeterRpc({ env: meter.env, userId: stableUserId })
	await meterStub.initializeStorageBytes({
		bytes: 0,
		updatedAt: now.toISOString(),
	})
	for (const resource of dailyEntitlementResources) {
		await meterStub.initialize({
			resource,
			day,
			count: 0,
			updatedAt: now.toISOString(),
		})
	}
	await meterStub.bootstrapDeletionState({
		leases: [
			{
				token: 'do-only-token',
				holder: 'secret-holder',
				acquiredAt: '2026-08-01T08:00:00.000Z',
				authority: 'do',
			},
		],
	})

	const doOnlyReport = await loadAdminUserMeterParityReport({
		db,
		env: meter.env,
		stableUserId,
		now,
	})
	// After mirror retirement, doOnly is expected (DO-authority leases no longer
	// write D1 rows); mirrorLeaseParity passes when only doOnly is non-zero.
	expect(doOnlyReport?.deletion).toMatchObject({
		d1ActiveLeaseCount: 0,
		doAuthorityLeaseCount: 1,
		tokenSetMismatches: {
			d1Only: 0,
			doOnly: 1,
			legacyWithoutD1: 0,
		},
		temporaryMirrorRetired: true,
		mirrorLeaseParity: true,
	})

	await meterStub.releaseWriteLease({ token: 'do-only-token' })
	await meterStub.bootstrapDeletionState({
		leases: [
			{
				token: 'legacy-only-token',
				holder: 'secret-holder',
				acquiredAt: '2026-08-01T07:00:00.000Z',
				authority: 'legacy',
			},
		],
	})
	const legacyReport = await loadAdminUserMeterParityReport({
		db,
		env: meter.env,
		stableUserId,
		now,
	})
	// legacyWithoutD1 still fails parity: every legacy-authority meter lease must
	// have a matching D1 row for the gate to pass.
	expect(legacyReport?.deletion).toMatchObject({
		d1ActiveLeaseCount: 0,
		doAuthorityLeaseCount: 0,
		doLegacyLeaseCount: 1,
		tokenSetMismatches: {
			d1Only: 0,
			doOnly: 0,
			legacyWithoutD1: 1,
		},
		temporaryMirrorRetired: true,
		mirrorLeaseParity: false,
	})
	assertNoLeaseSecrets(doOnlyReport)
	assertNoLeaseSecrets(legacyReport)
})

test('loadAdminUserMeterParityReport returns null for missing users', async () => {
	const { db } = createParityTestDb()
	const meter = createInMemoryUserMeterEnv()
	const report = await loadAdminUserMeterParityReport({
		db,
		env: meter.env,
		stableUserId: testStableUserIdFromEmail('missing@example.com'),
		now,
	})
	expect(report).toBeNull()
})

test('loadAdminUserMeterParityReport fails closed on repeated package-service cursor', async () => {
	const { sqlite, db } = createParityTestDb()
	const meter = createInMemoryUserMeterEnv()
	const dailyCounts = {
		email_sends_per_day: 0,
		email_receives_per_day: 0,
		execute_calls_per_day: 0,
		outbound_fetches_per_day: 0,
	}
	seedD1ParityBaseline({
		sqlite,
		stableUserId,
		dailyCounts,
		storageBytes: 0,
	})
	await seedMeterParityBaseline({
		meter,
		stableUserId,
		dailyCounts,
		storageBytes: 0,
	})

	const stuckCursor = '["pkg-a","web"]'
	const listPackageServiceStates = vi.fn(
		async (_input: MeterListPageInput) => ({
			states: [
				{
					packageId: 'pkg-a',
					serviceName: 'web',
					status: 'idle' as const,
					startedAt: null,
					sourceUpdatedAt: '2026-08-01T11:00:00.000Z',
					revision: 1,
					updatedAt: now.toISOString(),
					mirrorUpdatedAt: '1',
				},
			],
			nextStartAfter: stuckCursor,
			truncated: true,
		}),
	)
	const env = withMeterListOverrides(meter, {
		listPackageServiceStates,
	})

	const report = await loadAdminUserMeterParityReport({
		db,
		env,
		stableUserId,
		now,
	})
	expect(listPackageServiceStates).toHaveBeenCalledTimes(2)
	expect(listPackageServiceStates.mock.calls[0]?.[0]?.startAfter ?? null).toBe(
		null,
	)
	expect(listPackageServiceStates.mock.calls[1]?.[0]?.startAfter).toBe(
		stuckCursor,
	)
	expect(report?.packageServices).toMatchObject({
		truncated: true,
		parity: false,
	})
})

test('loadAdminUserMeterParityReport fails closed on zero-item write-lease cursor', async () => {
	const { sqlite, db } = createParityTestDb()
	const meter = createInMemoryUserMeterEnv()
	const dailyCounts = {
		email_sends_per_day: 0,
		email_receives_per_day: 0,
		execute_calls_per_day: 0,
		outbound_fetches_per_day: 0,
	}
	seedD1ParityBaseline({
		sqlite,
		stableUserId,
		dailyCounts,
		storageBytes: 0,
	})
	await seedMeterParityBaseline({
		meter,
		stableUserId,
		dailyCounts,
		storageBytes: 0,
	})

	const listWriteLeases = vi.fn(async (_input: MeterListPageInput) => ({
		leases: [] as Array<UserMeterWriteLeaseShadow>,
		nextStartAfter: 'stuck-lease-cursor',
		truncated: true,
	}))
	const env = withMeterListOverrides(meter, {
		listWriteLeases,
	})

	const report = await loadAdminUserMeterParityReport({
		db,
		env,
		stableUserId,
		now,
	})
	expect(listWriteLeases).toHaveBeenCalledTimes(1)
	expect(report?.deletion).toMatchObject({
		truncated: true,
		mirrorLeaseParity: false,
	})
})

test('loadAdminUserMeterParityReport reports mirrorRetired when entitlement_daily_counters is absent', async () => {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE users (
			id INTEGER PRIMARY KEY,
			stable_user_id TEXT UNIQUE NOT NULL,
			username TEXT NOT NULL,
			email TEXT NOT NULL,
			d1_storage_bytes INTEGER NOT NULL DEFAULT 0,
			deleting_at TEXT,
			created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
			updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
		);
		CREATE TABLE package_service_states (
			user_id TEXT NOT NULL,
			package_id TEXT NOT NULL,
			service_name TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('running', 'idle', 'stopped', 'error')),
			started_at TEXT,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (user_id, package_id, service_name)
		);
		CREATE TABLE account_write_leases (
			token TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			holder TEXT NOT NULL,
			acquired_at TEXT NOT NULL,
			released_at TEXT
		);
	`)
	const db = createD1FromSqlite(sqlite)
	const meter = createInMemoryUserMeterEnv()
	insertUser(sqlite, { stableUserId, d1StorageBytes: 0 })
	const meterStub = userMeterRpc({ env: meter.env, userId: stableUserId })
	await meterStub.initialize({
		resource: 'email_sends_per_day',
		day,
		count: 4,
		updatedAt: now.toISOString(),
	})
	await meterStub.initializeStorageBytes({
		bytes: 0,
		updatedAt: now.toISOString(),
	})

	const report = await loadAdminUserMeterParityReport({
		db,
		env: meter.env,
		stableUserId,
		now,
	})
	expect(report?.daily).toMatchObject({
		mirrorRetired: true,
		mismatchCount: 0,
	})
	expect(
		report?.daily.resources.find(
			(row) => row.resource === 'email_sends_per_day',
		),
	).toMatchObject({
		d1Count: null,
		meterCount: 4,
		delta: null,
		parity: true,
	})
})

test('loadAdminUserMeterParityReport still compares D1 daily counts when mirror table exists', async () => {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE users (
			id INTEGER PRIMARY KEY,
			stable_user_id TEXT UNIQUE NOT NULL,
			username TEXT NOT NULL,
			email TEXT NOT NULL,
			password_hash TEXT,
			d1_storage_bytes INTEGER NOT NULL DEFAULT 0,
			deleting_at TEXT,
			active_write_count INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
			updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
		);
		CREATE TABLE entitlement_daily_counters (
			user_id TEXT NOT NULL,
			resource TEXT NOT NULL,
			day TEXT NOT NULL,
			count INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (user_id, resource, day)
		);
		CREATE TABLE package_service_states (
			user_id TEXT NOT NULL,
			package_id TEXT NOT NULL,
			service_name TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('running', 'idle', 'stopped', 'error')),
			started_at TEXT,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (user_id, package_id, service_name)
		);
		CREATE TABLE account_write_leases (
			token TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			holder TEXT NOT NULL,
			acquired_at TEXT NOT NULL,
			released_at TEXT
		);
	`)
	const db = createD1FromSqlite(sqlite)
	const meter = createInMemoryUserMeterEnv()
	insertUser(sqlite, { stableUserId, d1StorageBytes: 0 })
	for (const resource of dailyEntitlementResources) {
		sqlite
			.prepare(
				`INSERT INTO entitlement_daily_counters (
					user_id, resource, day, count, updated_at
				) VALUES (?, ?, ?, ?, ?)`,
			)
			.run(stableUserId, resource, day, 1, now.toISOString())
	}
	const meterStub = userMeterRpc({ env: meter.env, userId: stableUserId })
	for (const resource of dailyEntitlementResources) {
		await meterStub.initialize({
			resource,
			day,
			count: resource === 'email_sends_per_day' ? 9 : 1,
			updatedAt: now.toISOString(),
		})
	}
	await meterStub.initializeStorageBytes({
		bytes: 0,
		updatedAt: now.toISOString(),
	})
	const report = await loadAdminUserMeterParityReport({
		db,
		env: meter.env,
		stableUserId,
		now,
	})
	expect(report?.daily.mirrorRetired).toBe(false)
	expect(report?.daily.mismatchCount).toBe(1)
	expect(
		report?.daily.resources.find(
			(row) => row.resource === 'email_sends_per_day',
		),
	).toMatchObject({
		d1Count: 1,
		meterCount: 9,
		delta: -8,
		parity: false,
	})
})
