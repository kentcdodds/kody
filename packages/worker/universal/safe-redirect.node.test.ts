import { expect, test } from 'vitest'
import {
	defaultPostVerificationRedirect,
	normalizeRedirectTo,
	resolvePostAuthLandingPath,
	resolvePostVerificationRedirect,
	resolveVerifyEmailSuccessCta,
	stripLoginFromAuthorizePrompt,
} from '#universal/safe-redirect.ts'

test('normalizeRedirectTo accepts same-origin paths and rejects open redirects', () => {
	expect(normalizeRedirectTo('/oauth/authorize?client_id=1')).toBe(
		'/oauth/authorize?client_id=1',
	)
	expect(normalizeRedirectTo('/account#security')).toBe('/account#security')
	expect(normalizeRedirectTo('/path%20with%20spaces')).toBe(
		'/path%20with%20spaces',
	)
	expect(normalizeRedirectTo('/%2f%2fevil.example')).toBe('/%2f%2fevil.example')

	for (const rejected of [
		'https://evil.example',
		'//evil.example',
		'/\\evil.example',
		'/\\\\evil.example',
		'/%5cevil.example',
		'/%5Cevil.example',
		'/\tevil.example',
		'/evil\n.example',
		'/%00evil',
		'/%0aevil',
		null,
		'',
	]) {
		expect(normalizeRedirectTo(rejected)).toBeNull()
	}
})

test('stripLoginFromAuthorizePrompt drops login from absolute and path resumes', () => {
	expect(
		stripLoginFromAuthorizePrompt(
			'https://kody.codes/oauth/authorize?client_id=c&prompt=login',
		),
	).toBe('https://kody.codes/oauth/authorize?client_id=c')
	expect(
		stripLoginFromAuthorizePrompt(
			'/oauth/authorize?prompt=login%20consent&state=s',
		),
	).toBe('/oauth/authorize?prompt=consent&state=s')
	expect(stripLoginFromAuthorizePrompt('/oauth/authorize?prompt=consent')).toBe(
		'/oauth/authorize?prompt=consent',
	)
})

test('resolvePostAuthLandingPath strips prompt=login only for authorize', () => {
	expect(
		resolvePostAuthLandingPath(
			'/oauth/authorize?client_id=c&prompt=login&state=s',
		),
	).toBe('/oauth/authorize?client_id=c&state=s')
	expect(resolvePostAuthLandingPath('/account')).toBe('/account')
	expect(resolvePostAuthLandingPath('https://evil.example')).toBeNull()
})

test('post-verification redirect and success CTA preserve safe targets', () => {
	const oauthResume = '/oauth/authorize?client_id=demo&state=abc'

	expect(resolvePostVerificationRedirect(null)).toBe(
		defaultPostVerificationRedirect,
	)
	expect(resolvePostVerificationRedirect(oauthResume)).toBe(oauthResume)
	expect(
		resolvePostVerificationRedirect(
			'/oauth/authorize?client_id=demo&prompt=login',
		),
	).toBe('/oauth/authorize?client_id=demo')
	expect(resolvePostVerificationRedirect('https://evil.example')).toBe(
		defaultPostVerificationRedirect,
	)

	expect(resolveVerifyEmailSuccessCta(oauthResume)).toMatchObject({
		href: oauthResume,
		label: 'Continue authorization',
	})
	expect(resolveVerifyEmailSuccessCta(null)).toMatchObject({
		href: defaultPostVerificationRedirect,
		label: 'Continue to onboarding',
	})
	expect(resolveVerifyEmailSuccessCta('/account')).toMatchObject({
		href: '/account',
		label: 'Continue',
	})
	expect(resolveVerifyEmailSuccessCta('https://evil.example')).toMatchObject({
		href: defaultPostVerificationRedirect,
		label: 'Continue to onboarding',
	})
})
