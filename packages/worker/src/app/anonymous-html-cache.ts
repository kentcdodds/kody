/**
 * Shared Cache-Control for anonymous marketing HTML. Session pages and any
 * response that sets a cookie stay `no-store`. The origin Worker stores
 * cookie-less GET responses in `caches.default` keyed on canonical origin +
 * pathname + search plus a `__accept=html` marker; markdown-preferring
 * `Accept` values (`prefersMarkdown`) bypass the store. Hits restore the miss
 * `Vary` (`Cookie`, plus `Accept` on negotiated routes) so intermediary
 * caches still split on the session cookie.
 */

import { createMatcher } from 'remix/route-pattern/match'
import { routes } from '#universal/routes.ts'
import { requestHasSiteBannerDismissCookie } from '#universal/site-banner-cookie.ts'

export const sessionCookieName = 'kody_session'

export const anonymousHtmlCacheControl =
	'public, max-age=60, stale-while-revalidate=300'

/**
 * Package surfaces answer to an owner's visibility switch (unpublish, make
 * private). Nothing purges shared caches on that switch, so they get the
 * shorter policy: a stale public response can outlive the change by at most
 * one minute instead of riding the marketing pages' revalidation window.
 */
export const anonymousVisibilityGatedCacheControl = 'public, max-age=60'

const cacheableAnonymousExactPaths = new Set([
	'/',
	'/pricing',
	'/faq',
	'/blog',
	'/community',
	'/onboarding',
	'/guides',
])

// Public package surfaces: home, tree, and the listing-uuid shapes they
// replaced. Anonymous markup for these is viewer-independent, and anonymous
// traffic is most of what they see.
const cacheableAnonymousRouteMatchers = [
	routes.communityPackage,
	routes.communityPackageTree,
	routes.communityDetail,
	routes.communityDetailFiles,
].map((route) => createMatcher(route.pattern))

const matcherOrigin = 'https://kody.local'

export function isVisibilityGatedAnonymousPath(pathname: string) {
	const url = new URL(pathname, matcherOrigin)
	return cacheableAnonymousRouteMatchers.some(
		(matcher) => matcher.match(url) !== null,
	)
}

export function isCacheableAnonymousPath(pathname: string) {
	if (cacheableAnonymousExactPaths.has(pathname)) return true
	if (pathname.startsWith('/onboarding/step-')) return true
	if (pathname.startsWith('/guides/')) {
		const rest = pathname.slice('/guides/'.length)
		return rest.length > 0 && !rest.includes('/')
	}
	return isVisibilityGatedAnonymousPath(pathname)
}

export function requestHasSessionCookie(request: Request): boolean {
	const cookie = request.headers.get('Cookie') ?? ''
	return /(?:^|;\s*)kody_session=/.test(cookie)
}

export function resolveAppPageCacheControl(input: {
	pathname: string
	session: unknown | null
	request: Request
	responseSetsCookie: boolean
	/** Only successful documents are shared; a 404 or 401 must not outlive its cause. */
	status?: number
	/**
	 * `npm run dev`: the browser serves Vite's post-HMR `location.reload()` from
	 * its HTTP cache when the document is `public, max-age=60`, so an edit
	 * never shows. Nothing shares anonymous HTML locally anyway.
	 */
	localDev?: boolean
}): { cacheControl: string; vary?: string } {
	if (input.localDev) {
		return { cacheControl: 'no-store' }
	}
	if (input.session !== null) {
		return { cacheControl: 'no-store' }
	}
	if ((input.status ?? 200) !== 200) {
		return { cacheControl: 'no-store' }
	}
	if (input.responseSetsCookie) {
		return { cacheControl: 'no-store' }
	}
	if (requestHasSessionCookie(input.request)) {
		return { cacheControl: 'no-store' }
	}
	if (requestHasSiteBannerDismissCookie(input.request)) {
		return { cacheControl: 'no-store' }
	}
	if (!isCacheableAnonymousPath(input.pathname)) {
		return { cacheControl: 'no-store' }
	}
	return {
		cacheControl: isVisibilityGatedAnonymousPath(input.pathname)
			? anonymousVisibilityGatedCacheControl
			: anonymousHtmlCacheControl,
		vary: 'Cookie',
	}
}

export function publicSharedJsonCacheHeaders(): HeadersInit {
	return { 'Cache-Control': anonymousHtmlCacheControl }
}

export function anonymousPersonalizedJsonCacheHeaders(input: {
	personalized: boolean
	request: Request
	/** Payload for a surface an owner can make private; see the shorter policy. */
	visibilityGated?: boolean
}): HeadersInit {
	if (input.personalized || requestHasSessionCookie(input.request)) {
		return { 'Cache-Control': 'no-store' }
	}
	return {
		'Cache-Control': input.visibilityGated
			? anonymousVisibilityGatedCacheControl
			: anonymousHtmlCacheControl,
		Vary: 'Cookie',
	}
}
