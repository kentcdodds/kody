import { expect, test } from 'vitest'
import { resolveAuthorizeEmailVerified } from '#client/routes/oauth-authorize-email-verified.ts'

test('authorize emailVerified prefers a ready session over stale authorize-info', () => {
	expect(
		resolveAuthorizeEmailVerified({
			isSessionReady: true,
			sessionEmailVerified: false,
			infoEmailVerified: true,
		}),
	).toBe(false)
	expect(
		resolveAuthorizeEmailVerified({
			isSessionReady: true,
			sessionEmailVerified: true,
			infoEmailVerified: false,
		}),
	).toBe(true)
	expect(
		resolveAuthorizeEmailVerified({
			isSessionReady: false,
			sessionEmailVerified: false,
			infoEmailVerified: true,
		}),
	).toBe(true)
	expect(
		resolveAuthorizeEmailVerified({
			isSessionReady: false,
			sessionEmailVerified: true,
			infoEmailVerified: false,
		}),
	).toBe(false)
})
