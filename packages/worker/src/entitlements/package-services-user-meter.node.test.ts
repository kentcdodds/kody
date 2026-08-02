import { expect, test } from 'vitest'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { type UserMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import {
	countRunningPackageServices,
	packageServiceStateStaleMs,
} from './service.ts'

type SeedInput = {
	packageId: string
	serviceName: string
	status: 'running' | 'stopped' | 'error'
	sourceUpdatedAt: string
	startedAt?: string | null
}

async function seedService(
	env: { USER_METER?: DurableObjectNamespace },
	userId: string,
	input: SeedInput,
) {
	const meter = env.USER_METER!.get(
		env.USER_METER!.idFromName(userId),
	) as unknown as UserMeterRpc
	await meter.upsertPackageServiceState({
		packageId: input.packageId,
		serviceName: input.serviceName,
		status: input.status,
		startedAt: input.startedAt ?? null,
		sourceUpdatedAt: input.sourceUpdatedAt,
	})
}

test('D1-only stopped rows are ignored: empty meter returns zero', async () => {
	// Policy: D1 stopped/error rows are historical inventory and do not gate
	// liveness authority. countRunningPackageServices never reads D1; it reads
	// only the meter. An empty meter returns 0 even if D1 has stopped rows.
	const userId = await createStableUserIdFromEmail(
		'stopped-ignored@example.com',
	)
	const now = new Date('2026-08-01T21:27:00.000Z')
	const { env } = createInMemoryUserMeterEnv()

	const count = await countRunningPackageServices({ env, userId, now })
	expect(count).toBe(0)
})

test('D1-only fresh-running row is ignored by authority count — parity blocker', async () => {
	// Policy: a D1-only fresh-running row means a lifecycle dual-write shadow
	// missed the meter. This is a migration anomaly / parity blocker. The
	// authority count sees 0 (the meter is empty). Observe via
	// admin_user_meter_parity; roll back D1 authority if seen in production.
	const userId = await createStableUserIdFromEmail(
		'd1-only-running@example.com',
	)
	const now = new Date('2026-08-01T21:27:00.000Z')
	const { env } = createInMemoryUserMeterEnv()

	// countRunningPackageServices never consults D1; empty meter → 0.
	const count = await countRunningPackageServices({ env, userId, now })
	expect(count).toBe(0)
})

test('live meter fresh running rows are counted', async () => {
	const userId = await createStableUserIdFromEmail('fresh-running@example.com')
	const now = new Date('2026-08-01T21:27:00.000Z')
	const freshAt = now.toISOString()
	const { env } = createInMemoryUserMeterEnv()

	await seedService(env, userId, {
		packageId: 'pkg-a',
		serviceName: 'alpha',
		status: 'running',
		startedAt: freshAt,
		sourceUpdatedAt: freshAt,
	})
	await seedService(env, userId, {
		packageId: 'pkg-b',
		serviceName: 'beta',
		status: 'running',
		startedAt: freshAt,
		sourceUpdatedAt: freshAt,
	})

	const count = await countRunningPackageServices({ env, userId, now })
	expect(count).toBe(2)
})

test('stale running row does not count against the limit', async () => {
	const userId = await createStableUserIdFromEmail('stale-rows@example.com')
	const now = new Date('2026-08-01T21:27:00.000Z')
	const staleAt = new Date(
		now.valueOf() - packageServiceStateStaleMs - 1,
	).toISOString()
	const freshAt = now.toISOString()
	const { env } = createInMemoryUserMeterEnv()

	await seedService(env, userId, {
		packageId: 'pkg-stale',
		serviceName: 'stale-svc',
		status: 'running',
		startedAt: staleAt,
		sourceUpdatedAt: staleAt,
	})
	await seedService(env, userId, {
		packageId: 'pkg-fresh',
		serviceName: 'fresh-svc',
		status: 'running',
		startedAt: freshAt,
		sourceUpdatedAt: freshAt,
	})

	const count = await countRunningPackageServices({ env, userId, now })
	expect(count).toBe(1)
})

test('excludeService removes the specified service from the running count', async () => {
	const userId = await createStableUserIdFromEmail('exclude-svc@example.com')
	const now = new Date('2026-08-01T21:27:00.000Z')
	const freshAt = now.toISOString()
	const { env } = createInMemoryUserMeterEnv()

	await seedService(env, userId, {
		packageId: 'pkg-a',
		serviceName: 'alpha',
		status: 'running',
		startedAt: freshAt,
		sourceUpdatedAt: freshAt,
	})
	await seedService(env, userId, {
		packageId: 'pkg-b',
		serviceName: 'beta',
		status: 'running',
		startedAt: freshAt,
		sourceUpdatedAt: freshAt,
	})

	const withExclusion = await countRunningPackageServices({
		env,
		userId,
		now,
		excludeService: { packageId: 'pkg-a', serviceName: 'alpha' },
	})
	expect(withExclusion).toBe(1)

	const withoutExclusion = await countRunningPackageServices({
		env,
		userId,
		now,
	})
	expect(withoutExclusion).toBe(2)
})

test('empty meter (new user) returns zero', async () => {
	const userId = await createStableUserIdFromEmail('empty-user@example.com')
	const now = new Date('2026-08-01T21:27:00.000Z')
	const { env } = createInMemoryUserMeterEnv()

	const count = await countRunningPackageServices({ env, userId, now })
	expect(count).toBe(0)
})

test('USER_METER binding missing throws fail-closed', async () => {
	const userId = await createStableUserIdFromEmail('no-binding@example.com')
	const now = new Date('2026-08-01T21:27:00.000Z')
	const emptyEnv = {} as { USER_METER?: DurableObjectNamespace }

	await expect(
		countRunningPackageServices({ env: emptyEnv, userId, now }),
	).rejects.toThrow('USER_METER Durable Object binding is not configured.')
})

test('meter count is stable across calls (D1 drift is irrelevant)', async () => {
	// Authority is the meter only. Repeated calls return consistent results
	// regardless of any D1 state — D1 is never consulted.
	const userId = await createStableUserIdFromEmail('stable-meter@example.com')
	const now = new Date('2026-08-01T21:27:00.000Z')
	const freshAt = now.toISOString()
	const { env } = createInMemoryUserMeterEnv()

	await seedService(env, userId, {
		packageId: 'pkg-a',
		serviceName: 'alpha',
		status: 'running',
		startedAt: freshAt,
		sourceUpdatedAt: freshAt,
	})

	const first = await countRunningPackageServices({ env, userId, now })
	const second = await countRunningPackageServices({ env, userId, now })
	expect(first).toBe(1)
	expect(second).toBe(1)
})

test('lifecycle dual-write (upsertPackageServiceState) populates meter for enforcement', async () => {
	// Verify that shadow writes from lifecycle transitions are visible to the
	// authority count without any D1 bootstrap.
	const userId = await createStableUserIdFromEmail('shadow-write@example.com')
	const now = new Date('2026-08-01T21:27:00.000Z')
	const freshAt = now.toISOString()
	const { env } = createInMemoryUserMeterEnv()

	expect(await countRunningPackageServices({ env, userId, now })).toBe(0)

	await seedService(env, userId, {
		packageId: 'pkg-live',
		serviceName: 'live-svc',
		status: 'running',
		startedAt: freshAt,
		sourceUpdatedAt: freshAt,
	})
	expect(await countRunningPackageServices({ env, userId, now })).toBe(1)

	await seedService(env, userId, {
		packageId: 'pkg-live',
		serviceName: 'live-svc',
		status: 'stopped',
		startedAt: null,
		sourceUpdatedAt: new Date(now.valueOf() + 1000).toISOString(),
	})
	expect(await countRunningPackageServices({ env, userId, now })).toBe(0)
})
