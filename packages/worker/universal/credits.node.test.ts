import { expect, test } from 'vitest'
import {
	creditDebitCostMicroUsd,
	creditDebitRates,
	crossedCreditLowBalance,
	decideCreditAutoRefill,
	defaultCreditAutoRefillSettings,
	defaultCreditNotifySettings,
	formatCents,
	formatMicroUsd,
	microUsdPerCent,
	validateCreditAdminGrantCents,
	validateCreditAutoRefillSettings,
	validateCreditTopUpCents,
} from './credits.ts'
import { cloudflareComputeListUsd } from './plans.ts'

const now = new Date('2026-09-27T12:00:00.000Z')

test('debit rates are about 2× Cloudflare list and price cumulative units exactly', () => {
	expect(creditDebitRates.unique_worker_days.priceMicroUsd).toBe(
		Math.round(cloudflareComputeListUsd.uniqueWorkerDay * 2 * 1_000_000),
	)
	expect(creditDebitRates.durable_object_rows_read.priceMicroUsd).toBe(
		Math.round(
			cloudflareComputeListUsd.durableObjectRowsReadPerMillion * 2 * 1_000_000,
		),
	)
	expect(creditDebitCostMicroUsd('unique_worker_days', 1)).toBe(4_000)
	expect(creditDebitCostMicroUsd('unique_worker_days', 250)).toBe(1_000_000)
	expect(creditDebitCostMicroUsd('durable_object_rows_read', 1_000_000)).toBe(
		2_000,
	)
	expect(creditDebitCostMicroUsd('durable_object_rows_read', 499)).toBe(0)
	expect(creditDebitCostMicroUsd('durable_object_rows_read', 500)).toBe(1)
	for (const junk of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
		expect(creditDebitCostMicroUsd('unique_worker_days', junk)).toBe(0)
	}
	// Hourly increments sum to the cumulative cost with no drift.
	let accounted = 0
	let charged = 0
	for (const next of [499, 1_250, 7_777, 1_000_001]) {
		charged +=
			creditDebitCostMicroUsd('durable_object_rows_read', next) -
			creditDebitCostMicroUsd('durable_object_rows_read', accounted)
		accounted = next
	}
	expect(charged).toBe(
		creditDebitCostMicroUsd('durable_object_rows_read', accounted),
	)
})

test('top-up and admin grant amounts are bounded whole cents', () => {
	expect(validateCreditTopUpCents(1_000)).toEqual({ ok: true, cents: 1_000 })
	expect(validateCreditTopUpCents(499).ok).toBe(false)
	expect(validateCreditTopUpCents(50_001).ok).toBe(false)
	expect(validateCreditTopUpCents(10.5).ok).toBe(false)
	expect(validateCreditTopUpCents('1000').ok).toBe(false)
	expect(validateCreditAdminGrantCents(1)).toEqual({ ok: true, cents: 1 })
	expect(validateCreditAdminGrantCents(0).ok).toBe(false)
	expect(validateCreditAdminGrantCents(-500).ok).toBe(false)
	expect(validateCreditAdminGrantCents(100_001).ok).toBe(false)
})

test('auto-refill is off by default and needs a $5+ threshold, amount, and cap to turn on', () => {
	expect(defaultCreditAutoRefillSettings.enabled).toBe(false)
	expect(defaultCreditNotifySettings).toEqual({
		autoRefilled: true,
		monthlyCap: true,
		lowBalance: true,
	})
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
	expect(decideCreditAutoRefill(base)).toEqual({
		action: 'charge',
		amountCents: 2_500,
	})
	expect(
		decideCreditAutoRefill({ ...base, balanceMicroUsd: -1_000_000 }),
	).toEqual({ action: 'charge', amountCents: 2_500 })
	expect(
		decideCreditAutoRefill({
			...base,
			settings: { ...settings, enabled: false },
		}),
	).toEqual({ action: 'skip', reason: 'disabled' })
	expect(
		decideCreditAutoRefill({
			...base,
			settings: { ...settings, monthlyCapCents: null },
		}),
	).toEqual({ action: 'skip', reason: 'incomplete_settings' })
	expect(
		decideCreditAutoRefill({
			...base,
			settings: { ...settings, thresholdCents: null },
		}),
	).toEqual({ action: 'skip', reason: 'incomplete_settings' })
	expect(
		decideCreditAutoRefill({
			...base,
			balanceMicroUsd: 501 * microUsdPerCent,
		}),
	).toEqual({ action: 'skip', reason: 'above_threshold' })
	expect(
		decideCreditAutoRefill({ ...base, refilledThisMonthCents: 2_501 }),
	).toEqual({ action: 'cap_reached' })
	expect(
		decideCreditAutoRefill({ ...base, refilledThisMonthCents: 2_500 }),
	).toEqual({ action: 'charge', amountCents: 2_500 })
	expect(decideCreditAutoRefill({ ...base, hasPaymentMethod: false })).toEqual({
		action: 'skip',
		reason: 'no_payment_method',
	})
	expect(
		decideCreditAutoRefill({
			...base,
			lastFailedAt: '2026-09-27T01:00:00.000Z',
		}),
	).toEqual({ action: 'skip', reason: 'recent_failure' })
	expect(
		decideCreditAutoRefill({
			...base,
			lastFailedAt: '2026-09-26T11:00:00.000Z',
		}),
	).toEqual({ action: 'charge', amountCents: 2_500 })
})

test('low-balance notice fires once on crossing to $5 and only while auto-refill is off', () => {
	const five = 500 * microUsdPerCent
	expect(
		crossedCreditLowBalance({
			previousBalanceMicroUsd: five + 1,
			nextBalanceMicroUsd: five,
			autoRefillEnabled: false,
		}),
	).toBe(true)
	expect(
		crossedCreditLowBalance({
			previousBalanceMicroUsd: five,
			nextBalanceMicroUsd: 0,
			autoRefillEnabled: false,
		}),
	).toBe(false)
	expect(
		crossedCreditLowBalance({
			previousBalanceMicroUsd: five * 3,
			nextBalanceMicroUsd: 0,
			autoRefillEnabled: true,
		}),
	).toBe(false)
})

test('money formatting rounds balances toward zero to the cent', () => {
	expect(formatCents(1_234_567)).toBe('$12,345.67')
	expect(formatCents(-250)).toBe('−$2.50')
	expect(formatMicroUsd(12_349_999)).toBe('$12.34')
	expect(formatMicroUsd(-4_000)).toBe('$0.00')
	expect(formatMicroUsd(-1_234_000)).toBe('−$1.23')
})
