import { expect, test } from 'vitest'
import {
	buildOnboardingPath,
	onboardingPath,
	resolveOnboardingLoginPath,
	resolveOnboardingPendingVerificationPath,
} from '#client/routes/onboarding-redirect.ts'

test('onboarding redirect helpers preserve safe redirectTo and reject open redirects', () => {
	const oauthResume = '/oauth/authorize?client_id=demo&state=abc'

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
	expect(resolveOnboardingPendingVerificationPath('/\\evil.example')).toBe(
		'/pending-verification',
	)

	expect(resolveOnboardingLoginPath(null)).toBe(
		'/login?redirectTo=%2Fonboarding',
	)
	expect(resolveOnboardingLoginPath(oauthResume)).toBe(
		`/login?redirectTo=${encodeURIComponent(buildOnboardingPath(oauthResume))}`,
	)
	expect(resolveOnboardingLoginPath('https://evil.example')).toBe(
		'/login?redirectTo=%2Fonboarding',
	)
})
