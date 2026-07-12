import { expect, test } from 'vitest'
import { resolveContinueVerificationFeedback } from '#client/routes/pending-verification-continue.ts'

test('continue-after-verify treats missing session as an actionable error', () => {
	expect(resolveContinueVerificationFeedback({ emailVerified: true })).toEqual({
		status: 'verified',
		tone: 'info',
		message: null,
	})
	expect(resolveContinueVerificationFeedback({ emailVerified: false })).toEqual(
		{
			status: 'pending',
			tone: 'info',
			message:
				'Still waiting on verification. Open the link from your email, then try again.',
		},
	)
	expect(resolveContinueVerificationFeedback(null)).toEqual({
		status: 'error',
		tone: 'error',
		message: 'Unable to check verification status. Try again.',
	})
})
