import { expect, test } from 'vitest'
import {
	getUsernameFormatValidationError,
	getUsernameValidationError,
	resolveDisplayName,
	resolveStoredDisplayName,
	usernameFromEmail,
	usernameRequirements,
} from './username.ts'

test('usernames are DNS labels: reject underscores, map email locals, fall back display names', () => {
	expect(getUsernameFormatValidationError('some_user')).toBe(
		usernameRequirements,
	)
	expect(getUsernameValidationError('user_name')).toBe(usernameRequirements)
	expect(getUsernameFormatValidationError('has space')).toBe(
		usernameRequirements,
	)
	expect(getUsernameFormatValidationError('some-user')).toBeNull()
	expect(getUsernameFormatValidationError('Some-User')).toBe(
		usernameRequirements,
	)
	expect(getUsernameValidationError('jane-lee')).toBeNull()
	expect(getUsernameFormatValidationError('john.doe')).toBe(
		usernameRequirements,
	)
	expect(getUsernameFormatValidationError('user.name')).toBe(
		usernameRequirements,
	)
	expect(usernameFromEmail('some_user@example.com')).toBe('some-user')
	expect(
		resolveDisplayName({ email: 'user@example.com', username: 'some_user' }),
	).toBe('user')
})

test('resolveStoredDisplayName prefers non-empty trimmed display_name', () => {
	expect(resolveStoredDisplayName('Kent C. Dodds', 'kentcdodds')).toBe(
		'Kent C. Dodds',
	)
	expect(resolveStoredDisplayName('  Ada  ', 'ada')).toBe('Ada')
	expect(resolveStoredDisplayName('', 'kentcdodds')).toBe('kentcdodds')
	expect(resolveStoredDisplayName('   ', 'kentcdodds')).toBe('kentcdodds')
	expect(resolveStoredDisplayName(null, 'kentcdodds')).toBe('kentcdodds')
	expect(resolveStoredDisplayName(undefined, 'kentcdodds')).toBe('kentcdodds')
})
