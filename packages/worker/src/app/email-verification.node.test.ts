import { expect, test } from 'vitest'
import { buildEmailVerificationUrl } from '#app/email-verification.ts'
import {
	normalizeRedirectTo,
	resolvePostVerificationRedirect,
	resolveVerifyEmailSuccessCta,
} from '#app/safe-redirect.ts'

test('email verification links preserve safe resume targets and reject open redirects', () => {
	const oauthResume = '/oauth/authorize?client_id=demo&state=abc'
	const withResume = buildEmailVerificationUrl({
		appBaseUrl: 'https://kody.example',
		token: 'verify-token',
		redirectTo: oauthResume,
	})
	expect(withResume.pathname).toBe('/verify-email')
	expect(withResume.searchParams.get('token')).toBe('verify-token')
	expect(withResume.searchParams.get('redirectTo')).toBe(oauthResume)

	const withoutResume = buildEmailVerificationUrl({
		appBaseUrl: 'https://kody.example',
		token: 'verify-token',
		redirectTo: 'https://evil.example',
	})
	expect(withoutResume.searchParams.get('token')).toBe('verify-token')
	expect(withoutResume.searchParams.has('redirectTo')).toBe(false)

	expect(normalizeRedirectTo('//evil.example')).toBeNull()
	expect(normalizeRedirectTo('/\\evil.example')).toBeNull()
	expect(normalizeRedirectTo('/%5cevil.example')).toBeNull()
	expect(resolvePostVerificationRedirect('https://evil.example')).toBe(
		'/onboarding',
	)
	expect(resolveVerifyEmailSuccessCta(null)).toEqual({
		href: '/onboarding',
		label: 'Continue to onboarding',
		message:
			'Your email address has been verified. MCP access is now available. Continue onboarding to connect your AI agent.',
	})
	expect(resolveVerifyEmailSuccessCta(oauthResume)).toEqual({
		href: oauthResume,
		label: 'Continue authorization',
		message:
			'Your email address has been verified. MCP access is now available. Continue authorization to finish connecting your AI agent.',
	})
	expect(resolveVerifyEmailSuccessCta('/account')).toEqual({
		href: '/account',
		label: 'Continue',
		message:
			'Your email address has been verified. MCP access is now available.',
	})
	expect(resolveVerifyEmailSuccessCta('https://evil.example')).toEqual({
		href: '/onboarding',
		label: 'Continue to onboarding',
		message:
			'Your email address has been verified. MCP access is now available. Continue onboarding to connect your AI agent.',
	})
})
