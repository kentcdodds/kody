import { type SessionInfo, type SessionStatus } from '#client/session.ts'

export type AuthorizeSessionSnapshot = {
	session: SessionInfo | null
	status: SessionStatus
}

/**
 * Continue-after-verify needs the freshly fetched `/session` before the app
 * shell refresh lands. Prefer that override only while the shared snapshot is
 * still the pre-refresh identity; drop it once the shell catches up or the
 * signed-in user changes.
 */
export function sessionsMatch(
	left: SessionInfo | null | undefined,
	right: SessionInfo | null | undefined,
) {
	if (left === right) return true
	if (!left || !right) return false
	return (
		left.email === right.email && left.emailVerified === right.emailVerified
	)
}

export function resolveAuthorizeSession(input: {
	shared: AuthorizeSessionSnapshot
	override: SessionInfo | null | undefined
	overrideBaseline: SessionInfo | null | undefined
}): AuthorizeSessionSnapshot & { clearOverride: boolean } {
	if (input.override === undefined) {
		return {
			session: input.shared.session,
			status: input.shared.status,
			clearOverride: false,
		}
	}
	if (input.shared.status === 'ready') {
		const sharedCaughtUp = sessionsMatch(input.shared.session, input.override)
		const sharedIdentityChanged = !sessionsMatch(
			input.shared.session,
			input.overrideBaseline,
		)
		if (sharedCaughtUp || sharedIdentityChanged) {
			return {
				session: input.shared.session,
				status: input.shared.status,
				clearOverride: true,
			}
		}
	}
	return {
		session: input.override,
		status: 'ready',
		clearOverride: false,
	}
}
