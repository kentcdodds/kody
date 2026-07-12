/**
 * Maps a session probe on the pending-verification continue control to UI
 * feedback. A missing session is treated as a check failure (network or
 * signed-out), not as "still waiting".
 */
export function resolveContinueVerificationFeedback(
	session: { emailVerified: boolean } | null,
) {
	if (session?.emailVerified) {
		return {
			status: 'verified' as const,
			tone: 'info' as const,
			message: null,
		}
	}
	if (!session) {
		return {
			status: 'error' as const,
			tone: 'error' as const,
			message: 'Unable to check verification status. Try again.',
		}
	}
	return {
		status: 'pending' as const,
		tone: 'info' as const,
		message:
			'Still waiting on verification. Open the link from your email, then try again.',
	}
}
