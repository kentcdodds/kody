import { expect, test } from 'vitest'
import { getPkceValidationError } from './oauth-pkce.ts'

test('PKCE validation allows S256 challenges and rejects plain or method-less challenges', () => {
	expect(getPkceValidationError({ codeChallengeMethod: 'plain' })).toBeNull()
	expect(getPkceValidationError({})).toBeNull()
	expect(
		getPkceValidationError({
			codeChallenge: 'abc123',
			codeChallengeMethod: 'S256',
		}),
	).toBeNull()
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
