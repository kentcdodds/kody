import { expect, test } from 'vitest'
import {
	parseJsonArray,
	parseJsonStringArray,
	parseJsonWithFallback,
} from './json-parsing.ts'

test('JSON parsing helpers degrade corrupt and unexpected values safely', () => {
	expect(parseJsonWithFallback('{"ok":true}', null)).toEqual({ ok: true })
	expect(parseJsonWithFallback('{', { fallback: true })).toEqual({
		fallback: true,
	})
	expect(parseJsonArray('["one", 2, null]')).toEqual(['one', 2, null])
	expect(parseJsonArray('{"not":"an array"}')).toEqual([])
	expect(parseJsonStringArray('[" one ", 2, "", "two"]')).toEqual([
		' one ',
		'',
		'two',
	])
	expect(
		parseJsonStringArray('[" one ", 2, "", "two"]', {
			trim: true,
			omitEmpty: true,
		}),
	).toEqual(['one', 'two'])
})
