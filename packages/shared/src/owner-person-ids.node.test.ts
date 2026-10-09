import { expect, test } from 'vitest'
import {
	mintPersonId,
	ownerIdFromStored,
	parseOwnerId,
	parsePersonId,
	personIdFromStored,
} from './owner-person-ids.ts'

const stableId = 'a'.repeat(64)

test('parsers accept only trimmed 64-hex stable ids', () => {
	expect(parsePersonId(` ${stableId} `)).toBe(stableId)
	expect(parseOwnerId(stableId)).toBe(stableId)
	for (const invalid of [
		'',
		'A'.repeat(64),
		'a'.repeat(63),
		'user-1',
		null,
		undefined,
		42,
	]) {
		expect(parsePersonId(invalid)).toBeNull()
		expect(parseOwnerId(invalid)).toBeNull()
	}
})

test('stored ids are trimmed and must be non-empty', () => {
	expect(personIdFromStored(` ${stableId}`)).toBe(stableId)
	expect(ownerIdFromStored('system:email')).toBe('system:email')
	expect(() => personIdFromStored('  ')).toThrow('Person id is required')
	expect(() => ownerIdFromStored(null)).toThrow('Owner id is required')
})

test('new people get random 64-hex ids', () => {
	const first = mintPersonId()
	expect(first).toMatch(/^[a-f0-9]{64}$/)
	expect(mintPersonId()).not.toBe(first)
})
