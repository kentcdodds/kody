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
} from '#worker/entitlements/user-meter-do.ts'
import type * as EntitlementsService from '#worker/entitlements/service.ts'

const mockModule = vi.hoisted(() => ({
	/** Physical D1 payload recompute; the minimal test DB has no payload tables. */
	calculateUserD1StorageBytes: vi.fn(async () => 0),
}))

vi.mock('#worker/entitlements/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof EntitlementsService>()
	return {
		...actual,
		calculateUserD1StorageBytes: (...args: Array<unknown>) =>
			mockModule.calculateUserD1StorageBytes(...args),
	}
})

const { loadAdminUserMeterParityReport } =
	await import('./user-meter-parity.ts')

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
	if (input.deletingAt != null) {
		await meter.markDeleting({ deletingAt: input.deletingAt })
	}
}

function seedD1ParityBaseline(input: {
	sqlite: DatabaseSync
	stableUserId: string
	storageBytes: number
	packageServices?: Array<{
		packageId: string
		serviceName: string
		status: 'running' | 'idle' | 'stopped' | 'error'
		startedAt?: string | null
		updatedAt: string
	}>
	deletingAt?: string | null
}) {
	insertUser(input.sqlite, {
		stableUserId: input.stableUserId,
		d1StorageBytes: input.storageBytes,
		deletingAt: input.deletingAt ?? null,
	})
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
}

function assertNoLeaseSecrets(value: unknown) {
	const serialized = JSON.stringify(value)
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
				}
				return {
					...stub,
					listPackageServiceStates:
						overrides.listPackageServiceStates ??
						stub.listPackageServiceStates.bind(stub),
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
	mockModule.calculateUserD1StorageBytes.mockResolvedValue(4096)
	seedD1ParityBaseline({
		sqlite,
		stableUserId,
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
	})
	// One active DO write lease in the meter; D1 lease table is quiescent.
	const meterStub = userMeterRpc({ env: meter.env, userId: stableUserId })
	await meterStub.acquireWriteLease({
		token: 'active-lease-abc123',
		holder: 'holder-xyz789',
		acquiredAt: '2026-08-01T09:00:00.000Z',
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
			activeLeaseCount: 1,
		},
	})
	expect(report?.daily.resources).toHaveLength(4)
	expect(
		report?.daily.resources.map((row) => [row.resource, row.meterCount]),
	).toEqual([
		['email_sends_per_day', 3],
		['email_receives_per_day', 5],
		['execute_calls_per_day', 11],
		['outbound_fetches_per_day', 7],
	])
	expect(report?.daily.resources.every((row) => !row.needsBootstrap)).toBe(true)
	assertNoLeaseSecrets(report)
})

test('loadAdminUserMeterParityReport D1 lease rows are quiescent; activeLeaseCount is meter-only', async () => {
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
		storageBytes: 0,
	})
	// A quiescent D1 lease row: not queried by parity; does not affect activeLeaseCount.
	sqlite
		.prepare(
			`INSERT INTO account_write_leases (
				token, user_id, holder, acquired_at, released_at
			) VALUES ('d1-only-row', ?, 'some-holder', '2026-08-01T09:00:00.000Z', NULL)`,
		)
		.run(stableUserId)
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
	// D1 lease table is ignored; meter has no active leases.
	expect(report?.deletion).toMatchObject({
		d1DeletingAt: null,
		meterDeletingAt: null,
		deletingAtParity: true,
		activeLeaseCount: 0,
	})
	assertNoLeaseSecrets(report)
})

test('loadAdminUserMeterParityReport classifies mismatches and needsBootstrap without writing parity state', async () => {
	const { sqlite, db } = createParityTestDb()
	const meter = createInMemoryUserMeterEnv()
	mockModule.calculateUserD1StorageBytes.mockResolvedValue(100)
	insertUser(sqlite, { stableUserId, d1StorageBytes: 100 })
	sqlite
		.prepare(
			`INSERT INTO package_service_states (
				user_id, package_id, service_name, status, started_at, updated_at
			) VALUES (?, 'pkg-a', 'web', 'running', ?, ?)`,
		)
		.run(stableUserId, '2026-08-01T10:00:00.000Z', '2026-08-01T11:00:00.000Z')

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
	// Seed two active DO write leases in the meter.
	await meterStub.acquireWriteLease({
		token: 'meter-lease-aaa',
		holder: 'holder-one',
		acquiredAt: '2026-08-01T08:00:00.000Z',
	})
	await meterStub.acquireWriteLease({
		token: 'meter-lease-bbb',
		holder: 'holder-two',
		acquiredAt: '2026-08-01T07:00:00.000Z',
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
	expect(
		report?.daily.resources.find(
			(row) => row.resource === 'email_sends_per_day',
		),
	).toEqual({
		resource: 'email_sends_per_day',
		meterCount: 2,
		needsBootstrap: false,
	})
	expect(
		report?.daily.resources.find(
			(row) => row.resource === 'email_receives_per_day',
		),
	).toEqual({
		resource: 'email_receives_per_day',
		meterCount: null,
		needsBootstrap: true,
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
		d1DeletingAt: null,
		meterDeletingAt: null,
		deletingAtParity: true,
		activeLeaseCount: 2,
	})

	// Confirm the report was read-only (meter bootstrap state is unchanged).
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

test('loadAdminUserMeterParityReport reports deletingAtParity mismatch and correct activeLeaseCount', async () => {
	const { sqlite, db } = createParityTestDb()
	const meter = createInMemoryUserMeterEnv()
	// D1: user is marked deleting; meter: not yet marked.
	insertUser(sqlite, {
		stableUserId,
		d1StorageBytes: 0,
		deletingAt: '2026-08-01T08:00:00.000Z',
	})
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

	// Mismatch: D1 has deleting_at; meter does not.
	const mismatchReport = await loadAdminUserMeterParityReport({
		db,
		env: meter.env,
		stableUserId,
		now,
	})
	expect(mismatchReport?.deletion).toMatchObject({
		d1DeletingAt: '2026-08-01T08:00:00.000Z',
		meterDeletingAt: null,
		deletingAtParity: false,
		activeLeaseCount: 0,
	})

	// Align meter; parity restores and activeLeaseCount remains 0.
	await meterStub.markDeleting({ deletingAt: '2026-08-01T08:00:00.000Z' })
	const parityReport = await loadAdminUserMeterParityReport({
		db,
		env: meter.env,
		stableUserId,
		now,
	})
	expect(parityReport?.deletion).toMatchObject({
		d1DeletingAt: '2026-08-01T08:00:00.000Z',
		meterDeletingAt: '2026-08-01T08:00:00.000Z',
		deletingAtParity: true,
		activeLeaseCount: 0,
	})
	assertNoLeaseSecrets(mismatchReport)
	assertNoLeaseSecrets(parityReport)
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
	expect(report?.deletion).toMatchObject({
		d1DeletingAt: null,
		meterDeletingAt: null,
		deletingAtParity: true,
		activeLeaseCount: 0,
	})
})
