import { expect, test } from 'vitest'
import {
	getDnsSafeUsernameValidationError,
	getUsernameFormatValidationError,
	getUsernameValidationError,
	resolveDisplayName,
	usernameFromEmail,
	usernameRequirements,
} from './username.ts'

test('new and changed usernames must be DNS labels (no underscores)', () => {
	expect(getDnsSafeUsernameValidationError('some_user')).toBe(
		usernameRequirements,
	)
	expect(getUsernameValidationError('user_name')).toBe(usernameRequirements)
	expect(getDnsSafeUsernameValidationError('some-user')).toBeNull()
	expect(getUsernameValidationError('some-user')).toBeNull()
})

test('existing usernames with legacy underscores are still recognized', () => {
	// Recognition of stored usernames stays lenient so legacy accounts keep
	// display names, public lookup, and inbound email routing; only subdomain
	// hosting and new-username validation require the strict DNS-label shape.
	expect(getUsernameFormatValidationError('some_user')).toBeNull()
	expect(getUsernameFormatValidationError('has space')).toBe(
		usernameRequirements,
	)
	expect(
		resolveDisplayName({ email: 'legacy@example.com', username: 'some_user' }),
	).toBe('some_user')
})

test('usernameFromEmail maps underscores in the email local part to hyphens', () => {
	expect(usernameFromEmail('some_user@example.com')).toBe('some-user')
})
