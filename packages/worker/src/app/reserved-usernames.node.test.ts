import { expect, test } from 'vitest'
import {
	getReservedUsernameError,
	isReservedUsername,
} from './reserved-usernames.ts'
import { getUsernameValidationError, usernameRequirements } from './username.ts'

test('isReservedUsername matches brand, support, infrastructure, and email locals', () => {
	expect(isReservedUsername('kody')).toBe(true)
	expect(isReservedUsername('KODY')).toBe(true)
	expect(isReservedUsername(' support ')).toBe(true)
	expect(isReservedUsername('postmaster')).toBe(true)
	expect(isReservedUsername('no-reply')).toBe(true)
	expect(isReservedUsername('admin')).toBe(true)
	expect(isReservedUsername('mcp')).toBe(true)
})

test('isReservedUsername allows ordinary usernames', () => {
	expect(isReservedUsername('alice')).toBe(false)
	expect(isReservedUsername('kent-dodds-fan')).toBe(false)
	expect(isReservedUsername('my-support-bot')).toBe(false)
})

test('getReservedUsernameError returns a user-facing message', () => {
	expect(getReservedUsernameError('kody')).toBe('This username is reserved.')
	expect(getReservedUsernameError('alice')).toBeNull()
})

test('getUsernameValidationError rejects reserved usernames after format checks', () => {
	expect(getUsernameValidationError('kody')).toBe('This username is reserved.')
	expect(getUsernameValidationError('support')).toBe(
		'This username is reserved.',
	)
	expect(getUsernameValidationError('ab')).toBe(usernameRequirements)
	expect(getUsernameValidationError('valid-user')).toBeNull()
})
