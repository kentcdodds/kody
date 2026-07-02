import { expect, test } from 'vitest'
import {
	getPasswordPolicyError,
	maxPasswordLength,
	minPasswordLength,
} from './password-policy.ts'

test('password policy accepts allowed lengths and rejects out-of-range passwords', () => {
	expect(getPasswordPolicyError('short')).toBe(
		`Password must be at least ${minPasswordLength} characters.`,
	)
	expect(getPasswordPolicyError('')).toBe(
		`Password must be at least ${minPasswordLength} characters.`,
	)
	expect(getPasswordPolicyError('a'.repeat(maxPasswordLength + 1))).toBe(
		`Password must be at most ${maxPasswordLength} characters.`,
	)
	expect(getPasswordPolicyError('a'.repeat(minPasswordLength))).toBeNull()
	expect(getPasswordPolicyError('a'.repeat(maxPasswordLength))).toBeNull()
	expect(getPasswordPolicyError('a-longer-passphrase')).toBeNull()
})
