import { expect, test } from 'vitest'
import {
	dynamicWorkersIncludedPerAccountMonth,
	dynamicWorkerUsdPerUniqueDay,
	estimateDynamicWorkerUsd,
	fleetDynamicWorkerCostAlertUsd,
	fleetDynamicWorkerCostAlertUsdByPlan,
	formatDynamicWorkerUsd,
	toAdminDynamicWorkerCost,
} from './dynamic-worker-cost.ts'

test('estimateDynamicWorkerUsd multiplies unique days by the Cloudflare list price', () => {
	expect(dynamicWorkerUsdPerUniqueDay).toBe(0.002)
	expect(dynamicWorkersIncludedPerAccountMonth).toBe(1000)
	expect(estimateDynamicWorkerUsd(0)).toBe(0)
	expect(estimateDynamicWorkerUsd(1)).toBe(0.002)
	expect(estimateDynamicWorkerUsd(500)).toBe(1)
	expect(estimateDynamicWorkerUsd(-3)).toBe(0)
	expect(estimateDynamicWorkerUsd(Number.NaN)).toBe(0)
})

test('toAdminDynamicWorkerCost truncates to a non-negative integer day count', () => {
	expect(toAdminDynamicWorkerCost(12.9)).toEqual({
		uniqueWorkerDays: 12,
		estimatedGrossUsd: 0.024,
		usdPerUniqueDay: 0.002,
		includedPerAccountMonth: 1000,
	})
	expect(formatDynamicWorkerUsd(0.002)).toBe('$0.002')
	expect(formatDynamicWorkerUsd(1)).toBe('$1.00')
	expect(fleetDynamicWorkerCostAlertUsdByPlan).toEqual({
		free: 2,
		standard: 12,
		pro: 29,
	})
	expect(fleetDynamicWorkerCostAlertUsd('free')).toBe(2)
	expect(fleetDynamicWorkerCostAlertUsd('standard')).toBe(12)
	expect(fleetDynamicWorkerCostAlertUsd('pro')).toBe(29)
	expect(fleetDynamicWorkerCostAlertUsd('max')).toBeNull()
})
