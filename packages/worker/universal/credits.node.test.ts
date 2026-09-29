import { expect, test } from 'vitest'
import {
	creditDebitCostMicroUsd,
	crossedCreditLowBalance,
	decideCreditAutoRefill,
	formatCents,
	formatEstimatedCreditMicroUsd,
	formatMicroUsd,
	microUsdPerCent,
	validateCreditAdminGrantCents,
	validateCreditAutoRefillSettings,
	validateCreditTopUpCents,
} from './credits.ts'

const now = new Date('2026-09-27T12:00:00.000Z')

test('debit rates price cumulative units exactly', () => {
	const rates: Array<[Parameters<typeof creditDebitCostMicroUsd>, number]> = [
		[['unique_worker_days', 1], 4_000],
		[['unique_worker_days', 250], 1_000_000],
		[['durable_object_rows_read', 1_000_000], 2_000],
		[['durable_object_rows_read', 499], 0],
		[['durable_object_rows_read', 500], 1],
		[['unique_worker_days', 0], 0],
		[['unique_worker_days', -10], 0],
		[['unique_worker_days', Number.NaN], 0],
		[['unique_worker_days', Number.POSITIVE_INFINITY], 0],
	]
	expect(
		rates.map(([args]) => [args, creditDebitCostMicroUsd(...args)]),
	).toEqual(rates)
	// Hourly increments sum to the cumulative cost with no drift.
	let accounted = 0
	let charged = 0
	for (const next of [499, 1_250, 7_777, 1_000_001]) {
		charged +=
			creditDebitCostMicroUsd('durable_object_rows_read', next) -
			creditDebitCostMicroUsd('durable_object_rows_read', accounted)
		accounted = next
	}
	expect(charged).toBe(2_000)
})

test('top-up and admin grant amounts are bounded whole cents', () => {
	expect(validateCreditTopUpCents(1_000)).toEqual({ ok: true, cents: 1_000 })
	expect(validateCreditAdminGrantCents(1)).toEqual({ ok: true, cents: 1 })
	expect(
		[499, 50_001, 10.5, '1000'].filter(
			(cents) => validateCreditTopUpCents(cents).ok,
		),
	).toEqual([])
	expect(
		[0, -500, 100_001].filter(
			(cents) => validateCreditAdminGrantCents(cents).ok,
		),
	).toEqual([])
})

test('auto-refill is off by default and needs a $5+ threshold, amount, and cap to turn on', () => {
	expect(
		validateCreditAutoRefillSettings({
			enabled: false,
			thresholdCents: null,
			amountCents: null,
			monthlyCapCents: null,
		}).ok,
	).toBe(true)
	const valid = {
		enabled: true,
		thresholdCents: 500,
		amountCents: 2_500,
		monthlyCapCents: 10_000,
	}
	expect(validateCreditAutoRefillSettings(valid)).toEqual({
		ok: true,
		value: valid,
	})
	for (const invalid of [
		{ ...valid, thresholdCents: 499 },
		{ ...valid, thresholdCents: null },
		{ ...valid, monthlyCapCents: null },
		{ ...valid, amountCents: null },
		{ ...valid, monthlyCapCents: 2_000 },
		{ ...valid, amountCents: 1.5 },
		{ ...valid, enabled: 'yes' },
		null,
	]) {
		expect(validateCreditAutoRefillSettings(invalid).ok).toBe(false)
	}
})

test('auto-refill guards: disabled, incomplete, above threshold, cap, card, and backoff', () => {
	const settings = {
		enabled: true,
		thresholdCents: 500,
		amountCents: 2_500,
		monthlyCapCents: 5_000,
	}
	const base = {
		settings,
		balanceMicroUsd: 400 * microUsdPerCent,
		refilledThisMonthCents: 0,
		hasPaymentMethod: true,
		lastFailedAt: null,
		now,
	}
	type Input = Parameters<typeof decideCreditAutoRefill>[0]
	const charge = { action: 'charge', amountCents: 2_500 }
	const skip = (reason: string) => ({ action: 'skip', reason })
	const cases: Array<[Partial<Input>, unknown]> = [
		[{}, charge],
		[{ balanceMicroUsd: -1_000_000 }, charge],
		[{ settings: { ...settings, enabled: false } }, skip('disabled')],
		[
			{ settings: { ...settings, monthlyCapCents: null } },
			skip('incomplete_settings'),
		],
		[
			{ settings: { ...settings, thresholdCents: null } },
			skip('incomplete_settings'),
		],
		[{ balanceMicroUsd: 501 * microUsdPerCent }, skip('above_threshold')],
		[{ refilledThisMonthCents: 2_501 }, { action: 'cap_reached' }],
		[{ refilledThisMonthCents: 2_500 }, charge],
		[{ hasPaymentMethod: false }, skip('no_payment_method')],
		[{ lastFailedAt: '2026-09-27T01:00:00.000Z' }, skip('recent_failure')],
		[{ lastFailedAt: '2026-09-26T11:00:00.000Z' }, charge],
	]
	expect(
		cases.map(([overrides]) => [
			overrides,
			decideCreditAutoRefill({ ...base, ...overrides }),
		]),
	).toEqual(cases)
})

test('low-balance notice fires once on crossing to $5 and only while auto-refill is off', () => {
	const five = 500 * microUsdPerCent
	const cases: Array<[number, number, boolean, boolean]> = [
		// [previous, next, autoRefillEnabled, crossed]
		[five + 1, five, false, true],
		[five, 0, false, false],
		[five * 3, 0, true, false],
	]
	expect(
		cases.filter(
			([
				previousBalanceMicroUsd,
				nextBalanceMicroUsd,
				autoRefillEnabled,
				want,
			]) =>
				crossedCreditLowBalance({
					previousBalanceMicroUsd,
					nextBalanceMicroUsd,
					autoRefillEnabled,
				}) !== want,
		),
	).toEqual([])
})

test('money formatting rounds balances toward zero to the cent and keeps sub-cent debit rates visible', () => {
	expect([1_234_567, -250].map(formatCents)).toEqual(['$12,345.67', '−$2.50'])
	expect([12_349_999, -4_000, -1_234_000].map(formatMicroUsd)).toEqual([
		'$12.34',
		'$0.00',
		'−$1.23',
	])
	expect(
		[0, 4_000, 2_000, 6_580_000, -4_000].map(formatEstimatedCreditMicroUsd),
	).toEqual(['$0.00', '$0.004', '$0.002', '$6.58', '−$0.004'])
})
