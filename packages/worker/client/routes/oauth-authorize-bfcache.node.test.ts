import { expect, test } from 'vitest'
import { resolveSignInStatusAfterPageshow } from '#client/routes/oauth-authorize-bfcache.ts'

test('bfcache pageshow resets submitting sign-in so controls re-enable', () => {
	expect(resolveSignInStatusAfterPageshow(true, 'submitting')).toBe('idle')
	expect(resolveSignInStatusAfterPageshow(false, 'submitting')).toBe(
		'submitting',
	)
	expect(resolveSignInStatusAfterPageshow(true, 'idle')).toBe('idle')
	expect(resolveSignInStatusAfterPageshow(false, 'idle')).toBe('idle')
})
