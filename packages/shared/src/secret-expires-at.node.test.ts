import { expect, test } from 'vitest'
import {
	earliestSecretExpiresAt,
	fromDatetimeLocalValue,
	isSecretExpired,
	nextSecretExpiresAt,
	normalizeSecretExpiresAt,
	secretTtlMs,
	toDatetimeLocalValue,
} from './secret-expires-at.ts'

test('secret expiry normalizes UTC inputs, computes ttl, and round-trips datetime-local', () => {
	expect(normalizeSecretExpiresAt(null)).toBeNull()
	expect(normalizeSecretExpiresAt('')).toBeNull()
	expect(normalizeSecretExpiresAt('2026-12-01')).toBe(
		'2026-12-01T00:00:00.000Z',
	)
	expect(normalizeSecretExpiresAt('2026-12-01T15:30:00Z')).toBe(
		'2026-12-01T15:30:00.000Z',
	)
	expect(() => normalizeSecretExpiresAt('2026-12-01T15:30:00')).toThrow(
		/UTC timestamp/,
	)
	expect(() => normalizeSecretExpiresAt('2026-02-30')).toThrow(/calendar date/)

	const now = new Date('2026-08-23T12:00:00.000Z')
	expect(
		earliestSecretExpiresAt(
			'2026-12-01T00:00:00.000Z',
			'2026-09-01T00:00:00.000Z',
			null,
		),
	).toBe('2026-09-01T00:00:00.000Z')
	expect(isSecretExpired('2026-08-23T12:00:00.000Z', now)).toBe(true)
	expect(isSecretExpired('2026-08-23T12:00:01.000Z', now)).toBe(false)
	expect(secretTtlMs('2026-08-23T13:00:00.000Z', now)).toBe(60 * 60 * 1000)
	expect(
		nextSecretExpiresAt({
			existing: '2026-12-01T00:00:00.000Z',
			requested: null,
		}),
	).toBeNull()
	expect(
		nextSecretExpiresAt({
			existing: null,
			requested: '2027-01-01',
		}),
	).toBe('2027-01-01T00:00:00.000Z')

	const iso = '2026-12-01T15:30:00.000Z'
	const local = toDatetimeLocalValue(iso)
	expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
	expect(fromDatetimeLocalValue(local)).toBe(iso)
	expect(toDatetimeLocalValue(null)).toBe('')
})
