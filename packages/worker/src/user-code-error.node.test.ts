import { expect, test } from 'vitest'
import { isUserCodeError, UserCodeError } from './user-code-error.ts'

test('isUserCodeError walks a nested cause chain', () => {
	const root = new UserCodeError('boom')
	const wrapped = new Error('handler failed', {
		cause: new Error('step failed', { cause: root }),
	})
	expect(isUserCodeError(root)).toBe(true)
	expect(isUserCodeError(wrapped)).toBe(true)
	expect(isUserCodeError(new Error('platform blew up'))).toBe(false)
	expect(isUserCodeError('boom')).toBe(false)
	expect(isUserCodeError(null)).toBe(false)
})
