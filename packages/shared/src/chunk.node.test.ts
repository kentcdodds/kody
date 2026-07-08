import { expect, test } from 'vitest'
import { chunkArray, maxD1BoundParameters } from './chunk.ts'

test('splits into chunks of at most the requested size', () => {
	expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
	expect(chunkArray([1, 2], 2)).toEqual([[1, 2]])
	expect(chunkArray([], 3)).toEqual([])
})

test('rejects a non-positive chunk size', () => {
	expect(() => chunkArray([1], 0)).toThrow('Chunk size must be >= 1')
})

test('a full admin page fits D1 statement limits when chunked', () => {
	// 100 user ids with one extra fixed binding (the month) must split so no
	// statement exceeds the D1 bound parameter cap.
	const ids = Array.from({ length: 100 }, (_, index) => `user-${index}`)
	const chunks = chunkArray(ids, maxD1BoundParameters - 1)
	expect(chunks.length).toBe(2)
	for (const chunk of chunks) {
		expect(chunk.length + 1).toBeLessThanOrEqual(maxD1BoundParameters)
	}
	expect(chunks.flat()).toEqual(ids)
})
