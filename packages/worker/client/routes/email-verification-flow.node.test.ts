import { expect, test } from 'vitest'
import { resolveAuthorizeEmailVerified } from '#client/routes/oauth-authorize-email-verified.ts'
import { resolveAuthorizeSession } from '#client/routes/oauth-authorize-session.ts'
import { type SessionInfo } from '#client/session.ts'
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

	// Ready sessions trust the session flag; before ready, the info payload.
	const emailVerifiedCases: Array<[boolean, boolean, boolean, boolean]> = [
		[true, false, true, false],
		[true, true, false, true],
		[false, false, true, true],
		[false, true, false, false],
	]
	expect(
		emailVerifiedCases.filter(
			([isSessionReady, sessionEmailVerified, infoEmailVerified, want]) =>
				resolveAuthorizeEmailVerified({
					isSessionReady,
					sessionEmailVerified,
					infoEmailVerified,
				}) !== want,
		),
	).toEqual([])

	const unverifiedUser: SessionInfo = {
		email: 'user@example.com',
		emailVerified: false,
		emailVerificationDelivery: null,
		username: 'account-user',
		avatarUrl: null,
		roles: ['user'],
		permissions: [],
		featureFlags: {} as SessionInfo['featureFlags'],
	}
	const verifiedUser: SessionInfo = {
		...unverifiedUser,
		emailVerified: true,
	}
	const otherUser: SessionInfo = {
		...unverifiedUser,
		email: 'other@example.com',
		username: 'other-user',
	}
	// The verified override wins until the shared session catches up, changes
	// user, or signs out; then the override clears.
	const sessionCases: Array<[SessionInfo | null, SessionInfo | null, boolean]> =
		[
			[unverifiedUser, verifiedUser, false],
			[verifiedUser, verifiedUser, true],
			[otherUser, otherUser, true],
			[null, null, true],
		]
	for (const [shared, session, clearOverride] of sessionCases) {
		expect(
			resolveAuthorizeSession({
				shared: { session: shared, status: 'ready' },
				override: verifiedUser,
				overrideBaseline: unverifiedUser,
			}),
		).toEqual({ session, status: 'ready', clearOverride })
	}

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

	const passwordRedirects: Array<
		[Parameters<typeof resolvePasswordAuthRedirect>[0], string]
	> = [
		[
			{
				mode: 'signup',
				requiresTwoFactor: true,
				emailVerificationRequired: true,
				redirectTo: '/onboarding',
			},
			'/verify?redirectTo=%2Fonboarding',
		],
		[
			{
				mode: 'signup',
				emailVerificationRequired: true,
				redirectTo: '/account',
			},
			'/pending-verification?redirectTo=%2Faccount',
		],
		[
			{
				mode: 'signup',
				emailVerificationRequired: true,
				redirectTo: oauthResume,
			},
			`/pending-verification?redirectTo=${encodeURIComponent(oauthResume)}`,
		],
		[
			{
				mode: 'signup',
				emailVerificationRequired: true,
				redirectTo: 'https://evil.example/phish',
			},
			'/pending-verification',
		],
		[
			{
				mode: 'login',
				emailVerificationRequired: true,
				redirectTo: '/onboarding',
			},
			'/onboarding',
		],
		[{ mode: 'login' }, '/account'],
		[
			{
				mode: 'signup',
				emailVerificationRequired: false,
				redirectTo: '/secrets',
			},
			'/secrets',
		],
	]
	expect(
		passwordRedirects.filter(
			([input, want]) => resolvePasswordAuthRedirect(input) !== want,
		),
	).toEqual([])
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
