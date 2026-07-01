import { expect, test } from 'vitest'
import { getPkceValidationError } from './oauth-pkce.ts'

test('allows requests with no PKCE challenge (confidential clients)', () => {
	expect(getPkceValidationError({ codeChallengeMethod: 'plain' })).toBeNull()
	expect(getPkceValidationError({})).toBeNull()
})

test('allows S256 PKCE challenges', () => {
	expect(
		getPkceValidationError({
			codeChallenge: 'abc123',
			codeChallengeMethod: 'S256',
		}),
	).toBeNull()
})

test('rejects a plain or method-less PKCE challenge', () => {
	expect(
		getPkceValidationError({
			codeChallenge: 'abc123',
			codeChallengeMethod: 'plain',
		}),
	).toBe('PKCE code_challenge_method must be S256.')
	expect(getPkceValidationError({ codeChallenge: 'abc123' })).toBe(
		'PKCE code_challenge_method must be S256.',
	)
})
