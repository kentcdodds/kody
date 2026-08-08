/**
 * The live app session is authoritative for the authorize gate. Stale
 * authorize-info metadata must not keep approval available after the server
 * reports email_verification_required.
 */
export function resolveAuthorizeEmailVerified(input: {
	isSessionReady: boolean
	sessionEmailVerified?: boolean | null
	infoEmailVerified?: boolean | null
}) {
	if (input.isSessionReady) {
		return input.sessionEmailVerified === true
	}
	return input.infoEmailVerified === true
}
