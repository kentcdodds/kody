import { expect, test } from 'vitest'
import {
	ComputeOverageLimitError,
	EntitlementLimitError,
	JobIntervalFloorError,
	computeOverageLimitErrorCode,
	entitlementLimitErrorCode,
	jobIntervalFloorErrorCode,
} from '#worker/entitlements/errors.ts'
import {
	entitlementStructuredContent,
	toMcpEntitlementMetadata,
} from './entitlement-metadata.ts'

test('entitlement metadata is only for known plan-limit and quota denials', () => {
	const stockDenial = new EntitlementLimitError({
		resource: 'saved_packages',
		plan: 'free',
		limit: 10,
		current: 10,
		upgradeHint: 'Upgrade at /account/billing.',
	})
	expect(toMcpEntitlementMetadata(stockDenial)).toEqual({
		code: entitlementLimitErrorCode,
		resource: 'saved_packages',
		plan: 'free',
		limit: 10,
		current: 10,
		upgradeHint: 'Upgrade at /account/billing.',
	})
	expect(toMcpEntitlementMetadata(stockDenial)).not.toHaveProperty('used')
	expect(toMcpEntitlementMetadata(stockDenial)).not.toHaveProperty('remaining')
	expect(entitlementStructuredContent(stockDenial)).toEqual({
		entitlement: {
			code: entitlementLimitErrorCode,
			resource: 'saved_packages',
			plan: 'free',
			limit: 10,
			current: 10,
			upgradeHint: 'Upgrade at /account/billing.',
		},
	})

	const quotaDenial = new EntitlementLimitError({
		resource: 'execute_calls_per_day',
		plan: 'free',
		limit: 100,
		current: 100,
		upgradeHint: 'Upgrade at /account/billing.',
	})
	expect(toMcpEntitlementMetadata(quotaDenial)).toEqual({
		code: entitlementLimitErrorCode,
		resource: 'execute_calls_per_day',
		plan: 'free',
		limit: 100,
		current: 100,
		upgradeHint: 'Upgrade at /account/billing.',
		used: 100,
		remaining: 0,
	})

	const intervalDenial = new JobIntervalFloorError({
		plan: 'free',
		minIntervalMs: 15 * 60 * 1000,
	})
	expect(toMcpEntitlementMetadata(intervalDenial)).toMatchObject({
		code: jobIntervalFloorErrorCode,
		resource: 'scheduled_jobs',
		plan: 'free',
		minIntervalMs: 15 * 60 * 1000,
	})

	expect(toMcpEntitlementMetadata(new Error(stockDenial.message))).toEqual({
		code: entitlementLimitErrorCode,
		resource: 'saved_packages',
		plan: 'free',
		limit: 10,
		current: 10,
		upgradeHint: 'Upgrade at /account/billing.',
	})
	expect(
		toMcpEntitlementMetadata(new Error(intervalDenial.message)),
	).toMatchObject({
		code: jobIntervalFloorErrorCode,
		resource: 'scheduled_jobs',
		plan: 'free',
		minIntervalMs: 15 * 60 * 1000,
	})
	const computeDenial = new ComputeOverageLimitError({
		resource: 'unique_worker_days',
		plan: 'free',
		limit: 50,
		current: 50,
		disposition: 'soft_block',
	})
	expect(toMcpEntitlementMetadata(computeDenial)).toMatchObject({
		code: computeOverageLimitErrorCode,
		resource: 'unique_worker_days',
		plan: 'free',
		limit: 50,
		current: 50,
		disposition: 'soft_block',
	})
	expect(
		toMcpEntitlementMetadata(new Error(computeDenial.message)),
	).toMatchObject({
		code: computeOverageLimitErrorCode,
		resource: 'unique_worker_days',
		plan: 'free',
		limit: 50,
		current: 50,
		disposition: 'soft_block',
	})

	expect(toMcpEntitlementMetadata(new Error('Boom'))).toBeUndefined()
	expect(entitlementStructuredContent(new Error('Boom'))).toEqual({})
})
