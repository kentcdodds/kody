import { expect, test } from 'vitest'
import { planLimits } from '#universal/plans.ts'
import {
	EntitlementLimitError,
	JobIntervalFloorError,
	buildEntitlementUpgradeHint,
	buildJobIntervalFloorUpgradeHint,
	entitlementLimitErrorCode,
	jobIntervalFloorErrorCode,
} from '#worker/entitlements/errors.ts'
import {
	entitlementStructuredContent,
	toMcpEntitlementMetadata,
} from './entitlement-metadata.ts'

test('entitlement metadata is only for known plan-limit and quota denials', () => {
	const stockLimit = planLimits.free.maxSavedPackages
	const stockDenial = new EntitlementLimitError({
		resource: 'saved_packages',
		plan: 'free',
		limit: stockLimit,
		current: stockLimit,
		upgradeHint: buildEntitlementUpgradeHint('saved_packages'),
	})
	expect(toMcpEntitlementMetadata(stockDenial)).toEqual({
		code: entitlementLimitErrorCode,
		resource: 'saved_packages',
		plan: 'free',
		limit: stockLimit,
		current: stockLimit,
		upgradeHint: buildEntitlementUpgradeHint('saved_packages'),
	})
	expect(toMcpEntitlementMetadata(stockDenial)).not.toHaveProperty('used')
	expect(toMcpEntitlementMetadata(stockDenial)).not.toHaveProperty('remaining')
	const stockHint = buildEntitlementUpgradeHint('saved_packages')
	expect(entitlementStructuredContent(stockDenial)).toEqual({
		entitlement: {
			code: entitlementLimitErrorCode,
			resource: 'saved_packages',
			plan: 'free',
			limit: stockLimit,
			current: stockLimit,
			upgradeHint: stockHint,
		},
	})

	const quotaLimit = planLimits.free.maxExecuteCallsPerDay
	const quotaHint = buildEntitlementUpgradeHint('execute_calls_per_day')
	const quotaDenial = new EntitlementLimitError({
		resource: 'execute_calls_per_day',
		plan: 'free',
		limit: quotaLimit,
		current: quotaLimit,
		upgradeHint: quotaHint,
	})
	expect(toMcpEntitlementMetadata(quotaDenial)).toEqual({
		code: entitlementLimitErrorCode,
		resource: 'execute_calls_per_day',
		plan: 'free',
		limit: quotaLimit,
		current: quotaLimit,
		upgradeHint: quotaHint,
		used: quotaLimit,
		remaining: 0,
	})

	const intervalMs = planLimits.free.minJobIntervalMs
	const intervalDenial = new JobIntervalFloorError({
		plan: 'free',
		minIntervalMs: intervalMs,
	})
	expect(toMcpEntitlementMetadata(intervalDenial)).toEqual({
		code: jobIntervalFloorErrorCode,
		resource: 'scheduled_jobs',
		plan: 'free',
		upgradeHint: buildJobIntervalFloorUpgradeHint(),
		minIntervalMs: intervalMs,
	})

	expect(toMcpEntitlementMetadata(new Error(stockDenial.message))).toEqual({
		code: entitlementLimitErrorCode,
		resource: 'saved_packages',
		plan: 'free',
		limit: stockLimit,
		current: stockLimit,
		upgradeHint: stockHint,
	})
	expect(toMcpEntitlementMetadata(new Error(intervalDenial.message))).toEqual({
		code: jobIntervalFloorErrorCode,
		resource: 'scheduled_jobs',
		plan: 'free',
		upgradeHint: buildJobIntervalFloorUpgradeHint(),
		minIntervalMs: intervalMs,
	})
	expect(toMcpEntitlementMetadata(new Error('Boom'))).toBeUndefined()
	expect(entitlementStructuredContent(new Error('Boom'))).toEqual({})
})
