import { expect, test } from 'vitest'
import { isoTimestampDayKey, utcDayKey, utcMonthKey } from './date-keys.ts'

test('date keys derive stable UTC prefixes', () => {
	const date = new Date('2026-07-05T23:59:59.999Z')
	expect(utcDayKey(date)).toBe('2026-07-05')
	expect(utcMonthKey(date)).toBe('2026-07')
	expect(isoTimestampDayKey('2026-07-05T23:59:59.999Z')).toBe('2026-07-05')
})
