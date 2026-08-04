import { expect, test } from 'vitest'
import {
	coerceLegacyParityMinimumSuccessCount,
	legacyParitySqlInPlaceholders,
	legacyParityVerifyMaxBatch,
} from './legacy-parity.ts'

test('coerceLegacyParityMinimumSuccessCount fails closed on non-finite values', () => {
	expect(coerceLegacyParityMinimumSuccessCount(2)).toBe(2)
	expect(coerceLegacyParityMinimumSuccessCount(2.9)).toBe(2)
	expect(coerceLegacyParityMinimumSuccessCount(-3)).toBe(0)
	expect(coerceLegacyParityMinimumSuccessCount(Number.NaN)).toBeNull()
	expect(
		coerceLegacyParityMinimumSuccessCount(Number.POSITIVE_INFINITY),
	).toBeNull()
	expect(coerceLegacyParityMinimumSuccessCount(undefined)).toBeNull()
	expect(coerceLegacyParityMinimumSuccessCount('nope')).toBeNull()
})

test('legacyParitySqlInPlaceholders stays within the hard batch bound', () => {
	expect(legacyParitySqlInPlaceholders(1)).toBe('?')
	expect(legacyParitySqlInPlaceholders(3)).toBe('?, ?, ?')
	expect(
		legacyParitySqlInPlaceholders(legacyParityVerifyMaxBatch).split(', '),
	).toHaveLength(legacyParityVerifyMaxBatch)
	expect(() => legacyParitySqlInPlaceholders(0)).toThrow(/1\.\.500/)
	expect(() =>
		legacyParitySqlInPlaceholders(legacyParityVerifyMaxBatch + 1),
	).toThrow(/1\.\.500/)
})
