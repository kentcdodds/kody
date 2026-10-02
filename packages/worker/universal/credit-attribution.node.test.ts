import { expect, test } from 'vitest'
import {
	buildCreditAttributionBreakdown,
	creditAttributionAdHocName,
	creditAttributionForPackage,
} from './credit-attribution.ts'

test('buildCreditAttributionBreakdown attributes past-include credits to packages and Ad hoc', () => {
	const breakdown = buildCreditAttributionBreakdown({
		month: '2026-10',
		includes: [
			{ meter: 'unique_worker_days', include: 10 },
			{ meter: 'durable_object_rows_read', include: 1_000_000 },
		],
		dailyUnits: [
			{
				day: '2026-10-01',
				packageId: 'pkg-a',
				meter: 'unique_worker_days',
				units: 8,
			},
			{
				day: '2026-10-02',
				packageId: 'pkg-a',
				meter: 'unique_worker_days',
				units: 5,
			},
			{
				day: '2026-10-02',
				packageId: '',
				meter: 'unique_worker_days',
				units: 5,
			},
			{
				day: '2026-10-03',
				packageId: 'pkg-b',
				meter: 'durable_object_rows_read',
				units: 2_000_000,
			},
		],
		packageNames: new Map([
			['pkg-a', 'Alpha'],
			['pkg-b', 'Beta'],
		]),
		packageHrefs: new Map([
			['pkg-a', '/@me/alpha'],
			['pkg-b', '/@me/beta'],
		]),
	})

	expect(breakdown.totalCreditsMicroUsd).toBeGreaterThan(0)
	expect(breakdown.rows.map((row) => row.name)).toEqual([
		'Alpha',
		'Beta',
		creditAttributionAdHocName,
	])
	const alpha = breakdown.rows.find((row) => row.packageId === 'pkg-a')
	expect(alpha?.href).toBe('/@me/alpha')
	expect(
		alpha?.meters.some((meter) => meter.meter === 'unique_worker_days'),
	).toBe(true)
	const adHoc = breakdown.rows.find((row) => row.isAdHoc)
	expect(adHoc?.cumulative.at(-1)?.creditsMicroUsd).toBe(adHoc?.creditsMicroUsd)
	const shares = breakdown.rows.reduce((sum, row) => sum + row.share, 0)
	expect(shares).toBeCloseTo(1, 5)
})

test('unattributed units stay Ad hoc and never invent a package', () => {
	const breakdown = buildCreditAttributionBreakdown({
		month: '2026-10',
		includes: [{ meter: 'unique_worker_days', include: 0 }],
		dailyUnits: [
			{
				day: '2026-10-01',
				packageId: '',
				meter: 'unique_worker_days',
				units: 3,
			},
		],
		packageNames: new Map(),
		packageHrefs: new Map(),
	})
	expect(breakdown.rows).toHaveLength(1)
	expect(breakdown.rows[0]?.isAdHoc).toBe(true)
	expect(breakdown.rows[0]?.creditsMicroUsd).toBe(12_000)
})

test('creditAttributionForPackage returns a zero row when the package spent nothing', () => {
	const breakdown = buildCreditAttributionBreakdown({
		month: '2026-10',
		includes: [{ meter: 'unique_worker_days', include: 100 }],
		dailyUnits: [],
		packageNames: new Map(),
		packageHrefs: new Map(),
	})
	const row = creditAttributionForPackage(breakdown, 'pkg-missing')
	expect(row?.creditsMicroUsd).toBe(0)
	expect(row?.isAdHoc).toBe(false)
})
