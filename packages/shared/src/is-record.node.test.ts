import { expect, test } from 'vitest'
import { isRecord } from './is-record.ts'

test('isRecord accepts plain records only', () => {
	expect(isRecord({})).toBe(true)
	expect(isRecord({ key: 'value' })).toBe(true)
	expect(isRecord(Object.create(null))).toBe(true)

	expect(isRecord(null)).toBe(false)
	expect(isRecord(undefined)).toBe(false)
	expect(isRecord([])).toBe(false)
	expect(isRecord(['one'])).toBe(false)
	expect(isRecord('string')).toBe(false)
	expect(isRecord(42)).toBe(false)
	expect(isRecord(true)).toBe(false)
	expect(isRecord(() => {})).toBe(false)
})
