import { expect, test } from 'vitest'
import {
	getUsernameFormatValidationError,
	getUsernameValidationError,
	resolveDisplayName,
	usernameFromEmail,
	usernameRequirements,
} from './username.ts'

test('usernames must be DNS labels (no underscores)', () => {
	expect(getUsernameFormatValidationError('some_user')).toBe(
		usernameRequirements,
	)
	expect(getUsernameValidationError('user_name')).toBe(usernameRequirements)
	expect(getUsernameFormatValidationError('has space')).toBe(
		usernameRequirements,
	)
	expect(getUsernameFormatValidationError('some-user')).toBeNull()
	expect(getUsernameValidationError('some-user')).toBeNull()
	expect(
		resolveDisplayName({ email: 'user@example.com', username: 'some_user' }),
	).toBe('user')
})

test('usernameFromEmail maps underscores in the email local part to hyphens', () => {
	expect(usernameFromEmail('some_user@example.com')).toBe('some-user')
})
