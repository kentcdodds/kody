import { expect, test } from 'vitest'
import {
	getPasswordPolicyError,
	maxPasswordLength,
	minPasswordLength,
} from './password-policy.ts'

test('rejects passwords shorter than the minimum length', () => {
	expect(getPasswordPolicyError('short')).toBe(
		`Password must be at least ${minPasswordLength} characters.`,
	)
	expect(getPasswordPolicyError('')).toBe(
		`Password must be at least ${minPasswordLength} characters.`,
	)
})

test('rejects passwords longer than the maximum length', () => {
	expect(getPasswordPolicyError('a'.repeat(maxPasswordLength + 1))).toBe(
		`Password must be at most ${maxPasswordLength} characters.`,
	)
})

test('accepts passwords within the allowed length range', () => {
	expect(getPasswordPolicyError('a'.repeat(minPasswordLength))).toBeNull()
	expect(getPasswordPolicyError('a'.repeat(maxPasswordLength))).toBeNull()
	expect(getPasswordPolicyError('a-longer-passphrase')).toBeNull()
})
