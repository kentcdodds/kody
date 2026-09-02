import { expect, test } from 'vitest'
import { isUsablePasswordHash } from './usable-password.ts'

test('isUsablePasswordHash accepts only pbkdf2 hashes', () => {
	expect(isUsablePasswordHash('pbkdf2_sha256$100000$salt$hash')).toBe(true)
	expect(isUsablePasswordHash('not-a-pbkdf2-hash')).toBe(false)
	expect(isUsablePasswordHash(null)).toBe(false)
	expect(isUsablePasswordHash(undefined)).toBe(false)
	expect(isUsablePasswordHash('')).toBe(false)
})
