import { expect, test } from 'vitest'
import { isUsablePasswordHash } from './usable-password.ts'

test('isUsablePasswordHash accepts only pbkdf2 hashes', () => {
	expect(isUsablePasswordHash('pbkdf2_sha256$100000$salt$hash')).toBe(true)
	expect(isUsablePasswordHash('oauth_created_no_usable_password')).toBe(false)
	expect(isUsablePasswordHash('admin_created_no_usable_password')).toBe(false)
	expect(isUsablePasswordHash('platform_account_no_usable_password')).toBe(
		false,
	)
	expect(isUsablePasswordHash(null)).toBe(false)
	expect(isUsablePasswordHash(undefined)).toBe(false)
	expect(isUsablePasswordHash('')).toBe(false)
})
