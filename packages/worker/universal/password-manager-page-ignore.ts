import { createMatcher } from 'remix/route-pattern/match'
import { routePattern } from '#universal/route-pattern.ts'
import { routes } from '#universal/routes.ts'

/**
 * 1Password skips offers to save or fill every field on a page when `<body>`
 * carries this attribute.
 *
 * @see https://developer.1password.com/docs/web/compatible-website-design/
 */
export const passwordManagerPageIgnoreAttribute = 'data-1p-ignore'

const accountPrefix = routePattern(routes.account)
const adminPrefix = routePattern(routes.admin)

/**
 * Signed-in pages that render `AccountManagementShell` but do not live under
 * `/account` or `/admin`.
 */
const extraShellMatchers = [
	createMatcher(routePattern(routes.pendingVerification)),
	createMatcher(routePattern(routes.communityPackageApprovePublish)),
	createMatcher(routePattern(routes.communityPackageApproveChanges)),
]

function isWithinPrefix(pathname: string, prefix: string) {
	return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

/**
 * True for signed-in account-shell documents. Login, signup, password reset,
 * 2FA, and OAuth authorize stay fillable.
 */
export function shouldIgnorePasswordManagerPage(pathname: string) {
	if (isWithinPrefix(pathname, accountPrefix)) return true
	if (isWithinPrefix(pathname, adminPrefix)) return true
	const url = new URL(pathname, 'http://localhost')
	return extraShellMatchers.some((matcher) => matcher.match(url) != null)
}

export function pathnameFromAppUrl(url: string | undefined) {
	if (!url) return '/'
	try {
		return new URL(url, 'http://localhost').pathname
	} catch {
		return '/'
	}
}

/** Props for `<body>` on an account-shell document. Empty on auth pages. */
export function passwordManagerPageIgnoreProps(pathname: string) {
	if (!shouldIgnorePasswordManagerPage(pathname)) return {}
	return { [passwordManagerPageIgnoreAttribute]: true as const }
}
