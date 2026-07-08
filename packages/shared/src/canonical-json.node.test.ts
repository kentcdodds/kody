import { expect, test } from 'vitest'
import { canonicalJsonStringify } from './canonical-json.ts'

test('canonicalJsonStringify is stable across key insertion order', () => {
	expect(
		canonicalJsonStringify({ b: 1, a: { d: [2, { z: 3, y: 4 }], c: 5 } }),
	).toBe(canonicalJsonStringify({ a: { c: 5, d: [2, { y: 4, z: 3 }] }, b: 1 }))
	expect(canonicalJsonStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
	expect(canonicalJsonStringify([3, 1, 2])).toBe('[3,1,2]')
})
