import { expect, test } from 'vitest'
import { resolveAuthorizeEmailVerified } from '#client/routes/oauth-authorize-email-verified.ts'
import {
	buildOnboardingPath,
	onboardingPath,
	resolveOnboardingLoginPath,
	resolveOnboardingPendingVerificationPath,
} from '#client/routes/onboarding-redirect.ts'
import { resolveContinueVerificationFeedback } from '#client/routes/pending-verification-continue.ts'
import { buildPendingVerificationPath } from '#client/routes/pending-verification-path.ts'
import { resolvePasswordAuthRedirect } from '#client/routes/resolve-password-auth-redirect.ts'

test('email verification redirect helpers preserve safe targets and reject open redirects', () => {
	const oauthResume =
		'/oauth/authorize?response_type=code&client_id=demo&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&scope=profile&state=abc'

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

	expect(buildOnboardingPath(null)).toBe(onboardingPath)
	expect(buildOnboardingPath(oauthResume)).toBe(
		`/onboarding?redirectTo=${encodeURIComponent(oauthResume)}`,
	)
	expect(buildOnboardingPath('https://evil.example')).toBe(onboardingPath)
	expect(buildOnboardingPath('/\\evil.example')).toBe(onboardingPath)

	expect(resolveOnboardingPendingVerificationPath(null)).toBe(
		'/pending-verification',
	)
	expect(resolveOnboardingPendingVerificationPath(oauthResume)).toBe(
		`/pending-verification?redirectTo=${encodeURIComponent(oauthResume)}`,
	)
	expect(resolveOnboardingPendingVerificationPath('https://evil.example')).toBe(
		'/pending-verification',
	)

	expect(resolveOnboardingLoginPath(null)).toBe(
		'/login?redirectTo=%2Fonboarding',
	)
	expect(resolveOnboardingLoginPath(oauthResume)).toBe(
		`/login?redirectTo=${encodeURIComponent(buildOnboardingPath(oauthResume))}`,
	)

	expect(buildPendingVerificationPath(null)).toBe('/pending-verification')
	expect(buildPendingVerificationPath('/onboarding')).toBe(
		'/pending-verification?redirectTo=%2Fonboarding',
	)
	expect(buildPendingVerificationPath('https://evil.example')).toBe(
		'/pending-verification',
	)

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
			redirectTo: oauthResume,
		}),
	).toBe(`/pending-verification?redirectTo=${encodeURIComponent(oauthResume)}`)
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

test('continue-after-verify feedback reflects session state without pinning copy', () => {
	expect(resolveContinueVerificationFeedback({ emailVerified: true })).toEqual({
		status: 'verified',
		tone: 'info',
		message: null,
	})
	expect(
		resolveContinueVerificationFeedback({ emailVerified: false }),
	).toMatchObject({
		status: 'pending',
		tone: 'info',
	})
	expect(
		resolveContinueVerificationFeedback({ emailVerified: false }).message,
	).toBeTruthy()
	expect(resolveContinueVerificationFeedback(null)).toMatchObject({
		status: 'error',
		tone: 'error',
	})
	expect(resolveContinueVerificationFeedback(null).message).toBeTruthy()
})
