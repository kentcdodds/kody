import { expect, test } from 'vitest'
import { parseJsonStringArray } from './json-string-array.ts'

test('parseJsonStringArray returns string entries from JSON arrays', () => {
	expect(parseJsonStringArray('["one",2,"two",null,""]')).toEqual([
		'one',
		'two',
		'',
	])
})

test('parseJsonStringArray falls back to an empty list for invalid values', () => {
	expect(parseJsonStringArray('{"one":true}')).toEqual([])
	expect(parseJsonStringArray('not json')).toEqual([])
})
