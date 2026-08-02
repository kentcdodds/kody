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

test('countRunningPackageServices uses meter lifecycle: empty, fresh, stale, exclude, stop', async () => {
	const userId = await createStableUserIdFromEmail(
		'service-meter-lifecycle@example.com',
	)
	const now = new Date('2026-08-01T21:27:00.000Z')
	const freshAt = now.toISOString()
	const staleAt = new Date(
		now.valueOf() - packageServiceStateStaleMs - 1,
	).toISOString()
	const { env } = createInMemoryUserMeterEnv()

	// Empty meter (and any D1-only inventory) does not count toward the limit.
	expect(await countRunningPackageServices({ env, userId, now })).toBe(0)

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
	await seedService(env, userId, {
		packageId: 'pkg-stale',
		serviceName: 'stale-svc',
		status: 'running',
		startedAt: staleAt,
		sourceUpdatedAt: staleAt,
	})
	expect(await countRunningPackageServices({ env, userId, now })).toBe(2)
	expect(
		await countRunningPackageServices({
			env,
			userId,
			now,
			excludeService: { packageId: 'pkg-a', serviceName: 'alpha' },
		}),
	).toBe(1)

	await seedService(env, userId, {
		packageId: 'pkg-a',
		serviceName: 'alpha',
		status: 'stopped',
		startedAt: null,
		sourceUpdatedAt: new Date(now.valueOf() + 1000).toISOString(),
	})
	await seedService(env, userId, {
		packageId: 'pkg-b',
		serviceName: 'beta',
		status: 'stopped',
		startedAt: null,
		sourceUpdatedAt: new Date(now.valueOf() + 1000).toISOString(),
	})
	expect(await countRunningPackageServices({ env, userId, now })).toBe(0)
})

test('countRunningPackageServices fails closed when USER_METER is missing', async () => {
	const userId = await createStableUserIdFromEmail('no-binding@example.com')
	const now = new Date('2026-08-01T21:27:00.000Z')
	const emptyEnv = {} as { USER_METER?: DurableObjectNamespace }

	await expect(
		countRunningPackageServices({ env: emptyEnv, userId, now }),
	).rejects.toThrow('USER_METER Durable Object binding is not configured.')
})
