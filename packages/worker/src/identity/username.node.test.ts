import { expect, test } from 'vitest'
import {
	getUsernameFormatValidationError,
	usernameFromEmail,
	usernameRequirements,
} from './username.ts'

test('username format validation rejects underscores', () => {
	expect(getUsernameFormatValidationError('some_user')).toBe(
		usernameRequirements,
	)
	expect(getUsernameFormatValidationError('user_name')).toBe(
		usernameRequirements,
	)
})

test('usernameFromEmail maps underscores in the email local part to hyphens', () => {
	expect(usernameFromEmail('some_user@example.com')).toBe('some-user')
})
