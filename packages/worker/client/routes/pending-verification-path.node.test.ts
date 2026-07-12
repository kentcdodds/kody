import { expect, test } from 'vitest'
import {
	buildPendingVerificationPath,
	resolvePostVerificationRedirect,
} from '#client/routes/pending-verification-path.ts'
import { normalizeRedirectTo } from '#app/safe-redirect.ts'

test('safe redirect helpers reject open redirects and preserve same-origin paths', () => {
	expect(normalizeRedirectTo('/oauth/authorize?client_id=1')).toBe(
		'/oauth/authorize?client_id=1',
	)
	expect(normalizeRedirectTo('https://evil.example')).toBeNull()
	expect(normalizeRedirectTo('//evil.example')).toBeNull()
	expect(normalizeRedirectTo(null)).toBeNull()

	expect(buildPendingVerificationPath(null)).toBe('/pending-verification')
	expect(buildPendingVerificationPath('/onboarding')).toBe(
		'/pending-verification?redirectTo=%2Fonboarding',
	)
	expect(buildPendingVerificationPath('https://evil.example')).toBe(
		'/pending-verification',
	)

	expect(resolvePostVerificationRedirect(null)).toBe('/onboarding')
	expect(resolvePostVerificationRedirect('/oauth/authorize?x=1')).toBe(
		'/oauth/authorize?x=1',
	)
	expect(resolvePostVerificationRedirect('https://evil.example')).toBe(
		'/onboarding',
	)
})
