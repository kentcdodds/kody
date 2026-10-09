import { createMatcher } from 'remix/route-pattern/match'
import { routes } from '#universal/routes.ts'

const profileMatcher = createMatcher(routes.profile.pattern)

/**
 * Username for `/@username` only. The `/@owner/…` namespace also holds the
 * canonical package URL, and reading `kentcdodds/devin` as a username would
 * render a profile page for it.
 */
export function getProfileUsernameFromPathname(pathname: string) {
	const matched = profileMatcher.match(new URL(pathname, 'http://localhost'))
		?.params.username
	if (matched) return matched
	// `/@slug/packages` is the signed-in repository list for that organization.
	const packages =
		/^\/@([a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9]))\/packages\/?$/.exec(pathname)
	return packages?.[1] ?? null
}

export function isProfilePathname(pathname: string) {
	return getProfileUsernameFromPathname(pathname) != null
}
