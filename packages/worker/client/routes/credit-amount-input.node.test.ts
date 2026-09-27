import { expect, test } from 'vitest'
import {
	validateCreditAutoRefillSettings,
	validateCreditTopUpCents,
} from '#universal/credits.ts'
import {
	formatCentsForInput,
	formatSignedMicroUsd,
	formatWholeDollars,
	parseDollarsToCents,
} from './credit-amount-input.ts'

test('dollar fields parse to whole cents the shared validators accept', () => {
	expect(parseDollarsToCents('25')).toBe(2_500)
	expect(parseDollarsToCents(' $12.5 ')).toBe(1_250)
	expect(parseDollarsToCents('1,000.05')).toBe(100_005)
	expect(parseDollarsToCents('')).toBeNull()
	expect(validateCreditTopUpCents(parseDollarsToCents('10'))).toEqual({
		ok: true,
		cents: 1_000,
	})

	for (const bad of ['abc', '1.234', '-5', '5e2']) {
		const cents = parseDollarsToCents(bad)
		expect(cents).toBeNaN()
		expect(validateCreditTopUpCents(cents).ok).toBe(false)
	}
})

test('auto-refill drafts round-trip through the input format', () => {
	for (const cents of [500, 1_250, 20_000]) {
		expect(parseDollarsToCents(formatCentsForInput(cents))).toBe(cents)
	}
	expect(formatCentsForInput(null)).toBe('')
	expect(
		validateCreditAutoRefillSettings({
			enabled: true,
			thresholdCents: parseDollarsToCents('5'),
			amountCents: parseDollarsToCents('25'),
			monthlyCapCents: parseDollarsToCents(''),
		}).ok,
	).toBe(false)
})

test('credit amounts render as short dollar labels with a sign on credits', () => {
	expect(formatWholeDollars(1_000)).toBe('$10')
	expect(formatWholeDollars(1_250)).toBe('$12.50')
	expect(formatSignedMicroUsd(25_000_000)).toBe('+$25.00')
	expect(formatSignedMicroUsd(-1_240_000)).toBe('−$1.24')
	expect(formatSignedMicroUsd(0)).toBe('$0.00')
})
