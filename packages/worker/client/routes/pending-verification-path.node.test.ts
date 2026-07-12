import { expect, test } from 'vitest'
import {
	buildPendingVerificationPath,
	resolvePostVerificationRedirect,
} from '#client/routes/pending-verification-path.ts'
import {
	normalizeRedirectTo,
	resolveVerifyEmailSuccessCta,
} from '#app/safe-redirect.ts'

test('safe redirect helpers reject open redirects and preserve same-origin paths', () => {
	expect(normalizeRedirectTo('/oauth/authorize?client_id=1')).toBe(
		'/oauth/authorize?client_id=1',
	)
	expect(normalizeRedirectTo('/account#security')).toBe('/account#security')
	expect(normalizeRedirectTo('/path%20with%20spaces')).toBe(
		'/path%20with%20spaces',
	)
	expect(normalizeRedirectTo('https://evil.example')).toBeNull()
	expect(normalizeRedirectTo('//evil.example')).toBeNull()
	expect(normalizeRedirectTo('/\\evil.example')).toBeNull()
	expect(normalizeRedirectTo('/\\\\evil.example')).toBeNull()
	expect(normalizeRedirectTo('/%5cevil.example')).toBeNull()
	expect(normalizeRedirectTo('/%5Cevil.example')).toBeNull()
	expect(normalizeRedirectTo('/\tevil.example')).toBeNull()
	expect(normalizeRedirectTo('/evil\n.example')).toBeNull()
	expect(normalizeRedirectTo('/%00evil')).toBeNull()
	expect(normalizeRedirectTo('/%0aevil')).toBeNull()
	expect(normalizeRedirectTo('/%2f%2fevil.example')).toBe('/%2f%2fevil.example')
	expect(normalizeRedirectTo(null)).toBeNull()
	expect(normalizeRedirectTo('')).toBeNull()

	expect(buildPendingVerificationPath(null)).toBe('/pending-verification')
	expect(buildPendingVerificationPath('/onboarding')).toBe(
		'/pending-verification?redirectTo=%2Fonboarding',
	)
	expect(buildPendingVerificationPath('https://evil.example')).toBe(
		'/pending-verification',
	)
	expect(buildPendingVerificationPath('/\\evil.example')).toBe(
		'/pending-verification',
	)

	expect(resolvePostVerificationRedirect(null)).toBe('/onboarding')
	expect(resolvePostVerificationRedirect('/oauth/authorize?x=1')).toBe(
		'/oauth/authorize?x=1',
	)
	expect(resolvePostVerificationRedirect('https://evil.example')).toBe(
		'/onboarding',
	)

	expect(resolveVerifyEmailSuccessCta('/oauth/authorize?client_id=1')).toEqual({
		href: '/oauth/authorize?client_id=1',
		label: 'Continue authorization',
		message:
			'Your email address has been verified. MCP access is now available. Continue authorization to finish connecting your AI agent.',
	})
	expect(resolveVerifyEmailSuccessCta('https://evil.example')).toEqual({
		href: '/onboarding',
		label: 'Continue to onboarding',
		message:
			'Your email address has been verified. MCP access is now available. Continue onboarding to connect your AI agent.',
	})
})
