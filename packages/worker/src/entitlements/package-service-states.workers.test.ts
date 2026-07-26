import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import {
	assertWithinEntitlement,
	countRunningPackageServices,
	packageServiceStateStaleMs,
} from '#worker/entitlements/service.ts'
import { EntitlementLimitError } from '#worker/entitlements/errors.ts'
import { planLimits } from '#worker/entitlements/plans.ts'
import { ensureEntitlementTestSchema } from '#worker/entitlements/test-schema.ts'
import { seedAccount } from '#worker/test-support/workers-seed.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'

async function upsertServiceState(input: {
	userId: string
	packageId: string
	serviceName: string
	status: 'running' | 'idle' | 'stopped' | 'error'
	updatedAt: string
	startedAt?: string | null
}) {
	await env.APP_DB.prepare(
		`INSERT INTO package_service_states (
			user_id, package_id, service_name, status, started_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id, package_id, service_name) DO UPDATE SET
			status = excluded.status,
			started_at = excluded.started_at,
			updated_at = excluded.updated_at`,
	)
		.bind(
			input.userId,
			input.packageId,
			input.serviceName,
			input.status,
			input.startedAt ?? null,
			input.updatedAt,
		)
		.run()
}

test('package_service_states counts fresh running rows and enforces the plan boundary', async () => {
	await ensureEntitlementTestSchema(env.APP_DB)
	const now = new Date('2026-07-26T12:00:00.000Z')
	const userId = await createStableUserIdFromEmail(
		`svc-count-${crypto.randomUUID()}@example.com`,
	)
	const otherUserId = await createStableUserIdFromEmail(
		`svc-count-other-${crypto.randomUUID()}@example.com`,
	)
	const fresh = now.toISOString()
	const stale = new Date(
		now.valueOf() - packageServiceStateStaleMs - 1,
	).toISOString()

	await upsertServiceState({
		userId,
		packageId: 'pkg-a',
		serviceName: 'alpha',
		status: 'running',
		startedAt: fresh,
		updatedAt: fresh,
	})
	await upsertServiceState({
		userId,
		packageId: 'pkg-b',
		serviceName: 'beta',
		status: 'stopped',
		updatedAt: fresh,
	})
	await upsertServiceState({
		userId,
		packageId: 'pkg-c',
		serviceName: 'gamma',
		status: 'error',
		updatedAt: fresh,
	})
	await upsertServiceState({
		userId,
		packageId: 'pkg-d',
		serviceName: 'delta',
		status: 'idle',
		updatedAt: fresh,
	})
	await upsertServiceState({
		userId,
		packageId: 'pkg-e',
		serviceName: 'stale',
		status: 'running',
		startedAt: stale,
		updatedAt: stale,
	})
	await upsertServiceState({
		userId: otherUserId,
		packageId: 'pkg-a',
		serviceName: 'alpha',
		status: 'running',
		startedAt: fresh,
		updatedAt: fresh,
	})

	expect(
		await countRunningPackageServices({
			db: env.APP_DB,
			userId,
			now,
		}),
	).toBe(1)
	expect(
		await countRunningPackageServices({
			db: env.APP_DB,
			userId,
			now,
			excludeService: { packageId: 'pkg-a', serviceName: 'alpha' },
		}),
	).toBe(0)

	await upsertServiceState({
		userId,
		packageId: 'pkg-f',
		serviceName: 'epsilon',
		status: 'running',
		startedAt: fresh,
		updatedAt: fresh,
	})
	expect(
		await countRunningPackageServices({
			db: env.APP_DB,
			userId,
			now,
			excludeService: { packageId: 'pkg-a', serviceName: 'alpha' },
		}),
	).toBe(1)

	const email = `svc-limit-${crypto.randomUUID()}@example.com`
	const limitUserId = await createStableUserIdFromEmail(email)
	await seedAccount({
		db: env.APP_DB,
		email,
		username: `svc-limit-${crypto.randomUUID().slice(0, 8)}`,
		plan: 'pro',
		stableUserId: limitUserId,
	})
	const limit = planLimits.pro.maxPackageServices
	for (let index = 0; index < limit; index += 1) {
		await upsertServiceState({
			userId: limitUserId,
			packageId: `pkg-${index}`,
			serviceName: 'worker',
			status: 'running',
			startedAt: fresh,
			updatedAt: fresh,
		})
	}

	const denied = await assertWithinEntitlement({
		db: env.APP_DB,
		userId: limitUserId,
		email,
		resource: 'package_services',
		now,
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!(denied instanceof EntitlementLimitError)) {
		throw new Error(
			'Expected EntitlementLimitError at the package_services boundary.',
		)
	}
	expect(denied.details).toMatchObject({
		resource: 'package_services',
		plan: 'pro',
		limit,
		current: limit,
	})

	await assertWithinEntitlement({
		db: env.APP_DB,
		userId: limitUserId,
		email,
		resource: 'package_services',
		now,
		getCurrent: async () =>
			await countRunningPackageServices({
				db: env.APP_DB,
				userId: limitUserId,
				now,
				excludeService: { packageId: 'pkg-0', serviceName: 'worker' },
			}),
	})
})
