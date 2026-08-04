import { expect, test } from 'vitest'
import {
	coerceLegacyParityMinimumSuccessCount,
	coerceLegacyParityMinimumUpdatedAt,
	legacyParitySqlInPlaceholders,
	legacyParityVerifyMaxBatch,
	normalizeLegacyParityWorkflowCheck,
} from './legacy-parity.ts'

test('coerceLegacyParityMinimumSuccessCount accepts only finite numbers', () => {
	expect(coerceLegacyParityMinimumSuccessCount(2)).toBe(2)
	expect(coerceLegacyParityMinimumSuccessCount(2.9)).toBe(2)
	expect(coerceLegacyParityMinimumSuccessCount(-3)).toBe(0)
	expect(coerceLegacyParityMinimumSuccessCount(0)).toBe(0)

	expect(coerceLegacyParityMinimumSuccessCount(Number.NaN)).toBeNull()
	expect(
		coerceLegacyParityMinimumSuccessCount(Number.POSITIVE_INFINITY),
	).toBeNull()
	expect(
		coerceLegacyParityMinimumSuccessCount(Number.NEGATIVE_INFINITY),
	).toBeNull()
	expect(coerceLegacyParityMinimumSuccessCount(undefined)).toBeNull()
	expect(coerceLegacyParityMinimumSuccessCount(null)).toBeNull()
	expect(coerceLegacyParityMinimumSuccessCount('')).toBeNull()
	expect(coerceLegacyParityMinimumSuccessCount('   ')).toBeNull()
	expect(coerceLegacyParityMinimumSuccessCount('2')).toBeNull()
	expect(coerceLegacyParityMinimumSuccessCount(false)).toBeNull()
	expect(coerceLegacyParityMinimumSuccessCount(true)).toBeNull()
	expect(coerceLegacyParityMinimumSuccessCount({})).toBeNull()
	expect(coerceLegacyParityMinimumSuccessCount([])).toBeNull()
})

test('coerceLegacyParityMinimumUpdatedAt canonicalizes valid UTC ISO and rejects malformed thresholds', () => {
	expect(coerceLegacyParityMinimumUpdatedAt(null)).toEqual({
		status: 'absent',
	})
	expect(coerceLegacyParityMinimumUpdatedAt(undefined)).toEqual({
		status: 'absent',
	})
	expect(coerceLegacyParityMinimumUpdatedAt('')).toEqual({ status: 'absent' })
	expect(coerceLegacyParityMinimumUpdatedAt('   ')).toEqual({
		status: 'absent',
	})

	expect(
		coerceLegacyParityMinimumUpdatedAt('2026-07-31T20:00:00.000Z'),
	).toEqual({
		status: 'valid',
		iso: '2026-07-31T20:00:00.000Z',
	})
	// Parseable non-canonical UTC form is normalized before lexical compare.
	expect(coerceLegacyParityMinimumUpdatedAt('2026-07-31T20:00:00Z')).toEqual({
		status: 'valid',
		iso: '2026-07-31T20:00:00.000Z',
	})

	expect(coerceLegacyParityMinimumUpdatedAt('0')).toEqual({
		status: 'invalid',
	})
	expect(coerceLegacyParityMinimumUpdatedAt('junk')).toEqual({
		status: 'invalid',
	})
	expect(
		coerceLegacyParityMinimumUpdatedAt('2026-02-30T00:00:00.000Z'),
	).toEqual({ status: 'invalid' })
	expect(coerceLegacyParityMinimumUpdatedAt('2026-07-31T20:00:00')).toEqual({
		status: 'invalid',
	})
	expect(coerceLegacyParityMinimumUpdatedAt(false)).toEqual({
		status: 'invalid',
	})
	expect(coerceLegacyParityMinimumUpdatedAt(0)).toEqual({
		status: 'invalid',
	})

	expect(
		normalizeLegacyParityWorkflowCheck({
			id: 'wf-1',
			minimumUpdatedAt: '0',
		}),
	).toEqual({
		id: 'wf-1',
		minimumUpdatedAt: { status: 'invalid' },
	})
	expect(normalizeLegacyParityWorkflowCheck('wf-1')).toEqual({
		id: 'wf-1',
		minimumUpdatedAt: { status: 'absent' },
	})
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
