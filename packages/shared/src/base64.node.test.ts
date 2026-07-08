import { expect, test } from 'vitest'
import {
	base64ToBytes,
	base64UrlToBytes,
	bytesToBase64,
	bytesToBase64Url,
	utf8ToBase64Url,
} from './base64.ts'

test('base64 and base64url round-trip standard, url-safe, and utf8 inputs', () => {
	const bytes = Uint8Array.from({ length: 256 }, (_, index) => index)
	expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)

	const urlBytes = Uint8Array.from([251, 239, 190, 0, 1, 62, 63])
	const encoded = bytesToBase64Url(urlBytes)
	expect(encoded).not.toMatch(/[+/=]/)
	expect(base64UrlToBytes(encoded)).toEqual(urlBytes)
	for (const length of [1, 2, 3, 4, 5]) {
		const sample = Uint8Array.from({ length }, (_, index) => 255 - index)
		expect(base64UrlToBytes(bytesToBase64Url(sample))).toEqual(sample)
	}

	expect(new TextDecoder().decode(base64UrlToBytes('aGVsbG8='))).toBe('hello')

	const utf8Encoded = utf8ToBase64Url('kody ✓')
	expect(new TextDecoder().decode(base64UrlToBytes(utf8Encoded))).toBe('kody ✓')
})
