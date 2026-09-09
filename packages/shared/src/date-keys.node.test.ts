import { expect, test } from 'vitest'
import {
	isoTimestampDayKey,
	utcDayKey,
	utcMonthKey,
	utcWeekStart,
} from './date-keys.ts'

test('date keys derive stable UTC prefixes', () => {
	const date = new Date('2026-07-05T23:59:59.999Z')
	expect(utcDayKey(date)).toBe('2026-07-05')
	expect(utcMonthKey(date)).toBe('2026-07')
	expect(isoTimestampDayKey('2026-07-05T23:59:59.999Z')).toBe('2026-07-05')
})

test('utcWeekStart is the UTC Monday of the containing week', () => {
	expect(utcWeekStart(new Date('2026-07-06T00:00:00.000Z'))).toBe('2026-07-06')
	expect(utcWeekStart(new Date('2026-07-08T15:00:00.000Z'))).toBe('2026-07-06')
	expect(utcWeekStart(new Date('2026-07-12T23:59:59.999Z'))).toBe('2026-07-06')
	expect(utcWeekStart(new Date('2026-07-13T00:00:00.000Z'))).toBe('2026-07-13')
})
