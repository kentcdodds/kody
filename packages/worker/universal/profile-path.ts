import { dnsSafeUsernamePatternSource } from '@kody-internal/shared/public-urls.ts'
import { createMatcher } from 'remix/route-pattern/match'
import { routes } from '#universal/routes.ts'

const profileMatcher = createMatcher(routes.profile.pattern)

/**
 * `/@slug/-/repositories` is the signed-in repository list. The capture is
 * {@link dnsSafeUsernamePatternSource}, the same handle shape as usernames.
 */
const orgRepositoryListPattern = new RegExp(
	`^/@(${dnsSafeUsernamePatternSource})/-/repositories/?$`,
)

/**
 * Username for `/@username` only. The `/@owner/…` namespace also holds the
 * canonical package URL, and reading `kentcdodds/devin` as a username would
 * render a profile page for it.
 */
export function getProfileUsernameFromPathname(pathname: string) {
	const matched = profileMatcher.match(new URL(pathname, 'http://localhost'))
		?.params.username
	if (matched) return matched
	return orgRepositoryListPattern.exec(pathname)?.[1] ?? null
}

export function isProfilePathname(pathname: string) {
	return getProfileUsernameFromPathname(pathname) != null
}
