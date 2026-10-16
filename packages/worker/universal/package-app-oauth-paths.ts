/**
 * Paths for first-party OAuth for hosted package apps.
 *
 * Authorize / consent stay on the app origin (kody.codes). Login, callback,
 * logout, and me run on the package-app host (`*.kody.run` and verified custom
 * domains) at the host root — never under `/packages/{leaf}`.
 */

export const packageAppOauthPaths = {
	authorize: '/oauth/package-app/authorize',
	login: '/_kody/auth/login',
	callback: '/_kody/auth/callback',
	logout: '/_kody/auth/logout',
	me: '/_kody/auth/me',
} as const

export const packageAppOauthPkceCookieName = '__Host-kody_pkg_oauth'
export const packageAppOauthPkceCookieNameInsecure = 'kody_pkg_oauth'
