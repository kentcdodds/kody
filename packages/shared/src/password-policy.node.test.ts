import { expect, test } from 'vitest'
import {
	getPasswordPolicyError,
	maxPasswordLength,
	minPasswordLength,
} from './password-policy.ts'

test('password policy accepts allowed lengths and rejects out-of-range passwords', () => {
	expect(getPasswordPolicyError('short')).toMatch(/at least/)
	expect(getPasswordPolicyError('')).toMatch(/at least/)
	expect(getPasswordPolicyError('a'.repeat(maxPasswordLength + 1))).toMatch(
		/at most/,
	)
	expect(getPasswordPolicyError('a'.repeat(minPasswordLength))).toBeNull()
	expect(getPasswordPolicyError('a'.repeat(maxPasswordLength))).toBeNull()
	expect(getPasswordPolicyError('a-longer-passphrase')).toBeNull()
})
