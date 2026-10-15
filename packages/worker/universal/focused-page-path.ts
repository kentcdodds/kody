import { createMatcher } from 'remix/route-pattern/match'
import { routes } from '#universal/routes.ts'

const focusedPageMatchers = [
	createMatcher(routes.communityPackageApproveCapabilities.pattern),
	createMatcher(routes.accountPackageApproveCapabilities.pattern),
	createMatcher(routes.orgApprovalBundle.pattern),
]

/**
 * Single-decision pages (approvals) that render with only the brand and the
 * account menu: no site nav, no workspace rail, no footer.
 */
export function isFocusedPagePathname(pathname: string) {
	const url = new URL(pathname, 'http://localhost')
	return focusedPageMatchers.some((matcher) => matcher.match(url) !== null)
}
