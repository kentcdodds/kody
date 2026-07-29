import { expect, test } from 'vitest'
import {
	getReservedUsernameError,
	isReservedUsername,
} from './reserved-usernames.ts'
import { getUsernameValidationError, usernameRequirements } from './username.ts'

test('reserved username validation rejects brand, support, and infrastructure names', () => {
	for (const reserved of [
		'kody',
		'KODY',
		' support ',
		'postmaster',
		'no-reply',
		'admin',
		'mcp',
		'kody-r-0123456789abcdef',
	]) {
		expect(isReservedUsername(reserved)).toBe(true)
		expect(getReservedUsernameError(reserved)).not.toBeNull()
		expect(getUsernameValidationError(reserved)).not.toBeNull()
	}

	for (const allowed of ['alice', 'kent-dodds-fan', 'my-support-bot']) {
		expect(isReservedUsername(allowed)).toBe(false)
		expect(getReservedUsernameError(allowed)).toBeNull()
		expect(getUsernameValidationError(allowed)).toBeNull()
	}

	expect(getUsernameValidationError('ab')).toBe(usernameRequirements)
})
