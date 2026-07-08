import { expect, test } from 'vitest'
import {
	base64ToBytes,
	base64UrlToBytes,
	bytesToBase64,
	bytesToBase64Url,
	utf8ToBase64Url,
} from './base64.ts'

test('base64 encoding round-trips arbitrary bytes', () => {
	const bytes = Uint8Array.from({ length: 256 }, (_, index) => index)
	expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
})

test('base64url encoding is url-safe, unpadded, and round-trips', () => {
	const bytes = Uint8Array.from([251, 239, 190, 0, 1, 62, 63])
	const encoded = bytesToBase64Url(bytes)
	expect(encoded).not.toMatch(/[+/=]/)
	expect(base64UrlToBytes(encoded)).toEqual(bytes)
	for (const length of [1, 2, 3, 4, 5]) {
		const sample = Uint8Array.from({ length }, (_, index) => 255 - index)
		expect(base64UrlToBytes(bytesToBase64Url(sample))).toEqual(sample)
	}
})

test('base64url decoding accepts standard base64 with padding', () => {
	expect(new TextDecoder().decode(base64UrlToBytes('aGVsbG8='))).toBe('hello')
})

test('utf8ToBase64Url encodes multi-byte characters', () => {
	const encoded = utf8ToBase64Url('kody ✓')
	expect(new TextDecoder().decode(base64UrlToBytes(encoded))).toBe('kody ✓')
})
