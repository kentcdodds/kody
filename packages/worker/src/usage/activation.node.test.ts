import { expect, test } from 'vitest'
import {
	activationMilestoneValues,
	countsTowardPackageActivation,
} from './activation.ts'

test('countsTowardPackageActivation excludes high-frequency HTTP surfaces', () => {
	expect(countsTowardPackageActivation('webhook')).toBe(false)
	expect(countsTowardPackageActivation('app_fetch')).toBe(false)
	expect(countsTowardPackageActivation('job')).toBe(true)
	expect(countsTowardPackageActivation('service')).toBe(true)
	expect(countsTowardPackageActivation('workflow')).toBe(true)
	expect(countsTowardPackageActivation(undefined)).toBe(true)
	expect(countsTowardPackageActivation(null)).toBe(true)
})

test('activation re-exports canonical milestone values from package-activation-state', () => {
	expect(activationMilestoneValues).toEqual([
		'package_run_succeeded',
		'package_activated',
	])
})
