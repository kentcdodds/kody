/**
 * Short-lived CDN cache for anonymous marketing HTML. Session pages and any
 * response that sets a cookie stay `no-store`. The request Cookie header is
 * part of the cache key (`Vary`) so a later signed-in visit cannot reuse
 * anonymous markup.
 */

export const sessionCookieName = 'kody_session'

export const anonymousHtmlCacheControl =
	'public, max-age=60, stale-while-revalidate=300'

const cacheableAnonymousPaths = new Set([
	'/',
	'/pricing',
	'/blog',
	'/community',
])

export function requestHasSessionCookie(request: Request): boolean {
	const cookie = request.headers.get('Cookie') ?? ''
	return /(?:^|;\s*)kody_session=/.test(cookie)
}

export function resolveAppPageCacheControl(input: {
	pathname: string
	session: unknown | null
	request: Request
	responseSetsCookie: boolean
}): { cacheControl: string; vary?: string } {
	if (input.session !== null) {
		return { cacheControl: 'no-store' }
	}
	if (input.responseSetsCookie) {
		return { cacheControl: 'no-store' }
	}
	if (requestHasSessionCookie(input.request)) {
		return { cacheControl: 'no-store' }
	}
	if (!cacheableAnonymousPaths.has(input.pathname)) {
		return { cacheControl: 'no-store' }
	}
	return {
		cacheControl: anonymousHtmlCacheControl,
		vary: 'Cookie',
	}
}
