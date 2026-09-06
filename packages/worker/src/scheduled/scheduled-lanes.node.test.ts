import { expect, test } from 'vitest'
import { getScheduledLaneCadence } from '@kody-internal/shared/jobs/scheduled-lanes.ts'

test('hourly cadence dispatches unverified account purge with retention', () => {
	const hourly = getScheduledLaneCadence(new Date('2026-09-02T12:00:00.000Z'))
	expect(hourly).toContain('retention')
	expect(hourly).toContain('unverified_account_purge')
	expect(hourly).toContain('compute_overage_billing')
	const offHour = getScheduledLaneCadence(new Date('2026-09-02T12:05:00.000Z'))
	expect(offHour.includes('retention')).toBe(false)
	expect(offHour.includes('unverified_account_purge')).toBe(false)
	expect(offHour.includes('compute_overage_billing')).toBe(false)
})
