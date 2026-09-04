import { createMatcher } from 'remix/route-pattern/match'
import { routes } from '#universal/routes.ts'

const profileMatcher = createMatcher(routes.profile.pattern)

/**
 * Username for `/@username` only. The `/@owner/…` namespace also holds the
 * canonical package URL, and reading `kentcdodds/devin` as a username would
 * render a profile page for it.
 */
export function getProfileUsernameFromPathname(pathname: string) {
	return (
		profileMatcher.match(new URL(pathname, 'http://localhost'))?.params
			.username ?? null
	)
}

export function isProfilePathname(pathname: string) {
	return getProfileUsernameFromPathname(pathname) != null
}
