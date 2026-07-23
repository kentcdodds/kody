import { expect, test } from 'vitest'
import { canonicalJson } from './canonical-json.ts'

test('canonical JSON sorts object keys by UTF-16 code units', () => {
	const canonical = canonicalJson({
		é: 1,
		Z: 2,
		a: 3,
		A: 4,
		'\uE000': 5,
		'😀': 6,
	})
	expect(Object.keys(JSON.parse(canonical) as Record<string, unknown>)).toEqual(
		['A', 'Z', 'a', 'é', '😀', '\uE000'],
	)
})
