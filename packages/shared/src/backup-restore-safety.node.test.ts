import { expect, test } from 'vitest'
import { truncateToUtf8Bytes, utf8ByteLength } from './backup-restore-safety.ts'

test('truncateToUtf8Bytes bounds by bytes without splitting code points', () => {
	expect(truncateToUtf8Bytes('plain ascii', 100)).toBe('plain ascii')
	expect(truncateToUtf8Bytes('abcdef', 3)).toBe('abc')

	// '€' is 3 UTF-8 bytes; a 4-byte budget must not emit half a code point.
	const truncated = truncateToUtf8Bytes('a€€', 4)
	expect(truncated).toBe('a€')
	expect(utf8ByteLength(truncated)).toBeLessThanOrEqual(4)

	const partial = truncateToUtf8Bytes('a€€', 5)
	expect(partial).toBe('a€')
	expect(utf8ByteLength(partial)).toBeLessThanOrEqual(5)
})
