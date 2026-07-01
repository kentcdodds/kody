import { expect, test } from 'vitest'
import { getPasswordPolicyError, minPasswordLength } from './password-policy.ts'

test('rejects passwords shorter than the minimum length', () => {
	expect(getPasswordPolicyError('short')).toBe(
		`Password must be at least ${minPasswordLength} characters.`,
	)
	expect(getPasswordPolicyError('')).toBe(
		`Password must be at least ${minPasswordLength} characters.`,
	)
})

test('accepts passwords at or above the minimum length', () => {
	expect(getPasswordPolicyError('a'.repeat(minPasswordLength))).toBeNull()
	expect(getPasswordPolicyError('a-longer-passphrase')).toBeNull()
})
