import { expect, test } from 'vitest'
import { resolvePasswordAuthRedirect } from '#client/routes/resolve-password-auth-redirect.ts'

test('password auth redirect prefers 2FA, then signup verification with preserved redirectTo, then account', () => {
	expect(
		resolvePasswordAuthRedirect({
			mode: 'signup',
			requiresTwoFactor: true,
			emailVerificationRequired: true,
			redirectTo: '/onboarding',
		}),
	).toBe('/verify?redirectTo=%2Fonboarding')

	expect(
		resolvePasswordAuthRedirect({
			mode: 'signup',
			emailVerificationRequired: true,
			redirectTo: '/account',
		}),
	).toBe('/pending-verification?redirectTo=%2Faccount')

	expect(
		resolvePasswordAuthRedirect({
			mode: 'signup',
			emailVerificationRequired: true,
			redirectTo:
				'/oauth/authorize?response_type=code&client_id=demo&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&scope=profile&state=abc',
		}),
	).toBe(
		'/pending-verification?redirectTo=%2Foauth%2Fauthorize%3Fresponse_type%3Dcode%26client_id%3Ddemo%26redirect_uri%3Dhttps%253A%252F%252Fexample.com%252Fcallback%26scope%3Dprofile%26state%3Dabc',
	)

	expect(
		resolvePasswordAuthRedirect({
			mode: 'signup',
			emailVerificationRequired: true,
			redirectTo: 'https://evil.example/phish',
		}),
	).toBe('/pending-verification')

	expect(
		resolvePasswordAuthRedirect({
			mode: 'login',
			emailVerificationRequired: true,
			redirectTo: '/onboarding',
		}),
	).toBe('/onboarding')

	expect(
		resolvePasswordAuthRedirect({
			mode: 'login',
		}),
	).toBe('/account')

	expect(
		resolvePasswordAuthRedirect({
			mode: 'signup',
			emailVerificationRequired: false,
			redirectTo: '/secrets',
		}),
	).toBe('/secrets')
})
