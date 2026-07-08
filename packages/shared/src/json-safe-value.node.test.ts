import { expect, test } from 'vitest'
import { toJsonSafeValue } from './json-safe-value.ts'

test('toJsonSafeValue strips non-JSON members and survives cycles', () => {
	expect(toJsonSafeValue({ keep: 1, drop: undefined, fn: () => {} })).toEqual({
		keep: 1,
	})

	// Unserializable values collapse to a string description rather than
	// throwing: the error message for Errors, String(value) otherwise.
	const cyclic: Record<string, unknown> = {}
	cyclic.self = cyclic
	expect(toJsonSafeValue(cyclic)).toBe('[object Object]')

	const unserializableError = new Error('boom')
	;(unserializableError as unknown as Record<string, unknown>).payload =
		BigInt(1)
	expect(toJsonSafeValue(unserializableError)).toBe('boom')
})
