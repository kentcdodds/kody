/**
 * Shared Cache-Control for anonymous marketing HTML, auth entry pages, and the
 * viewer-independent `/llms.txt` / `/docs/llms.txt` plain-text indexes. Session
 * pages and any response that sets a cookie stay `no-store`. The origin Worker
 * stores cookie-less GET responses in `caches.default` keyed on canonical
 * origin + pathname + search plus a `__accept=html` marker; markdown-preferring
 * `Accept` values (`prefersMarkdown`) bypass the store. Frame fetches
 * (`x-remix-target` or the `__frame` query param) bypass it too: those caches
 * key on the URL, and returning the document nests another site shell inside
 * the frame. Hits restore the miss `Vary` (`Cookie`, plus `Accept` on
 * negotiated routes) so intermediary caches still split on the session cookie.
 */

import { acquisitionPageSummaries } from '#universal/acquisition/metadata.ts'
import { createMatcher } from 'remix/route-pattern/match'
import { requestBypassesAnonymousDocumentCache } from '#universal/frame-constants.ts'
import { routes } from '#universal/routes.ts'

export const sessionCookieName = 'kody_session'

/**
 * Retired site-banner dismiss cookie. The feature is gone; browsers may still
 * send this HttpOnly cookie for years. Clear it when present so clients stop
 * shipping up to ~1.6 KB of dead UUIDs on every request.
 */
export const retiredSiteBannerDismissCookieName = 'kody_site_banner_dismiss'

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
	...acquisitionPageSummaries.map((page) => page.path),
	'/',
	'/pricing',
	'/for/business',
	'/faq',
	'/case-studies',
	'/blog',
	'/community',
	'/onboarding',
	'/docs',
	'/docs/connect',
	// Viewer-independent docs indexes (plain text, same Cache API path).
	'/llms.txt',
	'/docs/llms.txt',
	// Anonymous auth shells: Turnstile site key + OAuth provider list are
	// deployment config. Session cookies, Set-Cookie, and banner-dismiss
	// cookies still force no-store via resolveAppPageCacheControl.
	'/login',
	'/signup',
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
	// Read-only smart HTTP clone URLs must never enter the HTML edge cache.
	if (pathname.includes('.git/') || pathname.endsWith('.git')) return false
	const url = new URL(pathname, matcherOrigin)
	return cacheableAnonymousRouteMatchers.some(
		(matcher) => matcher.match(url) !== null,
	)
}

export function isCacheableAnonymousPath(pathname: string) {
	if (cacheableAnonymousExactPaths.has(pathname)) return true
	if (pathname.startsWith('/onboarding/step-')) return true
	if (pathname.startsWith('/docs/')) {
		const rest = pathname.slice('/docs/'.length)
		return rest.length > 0 && !rest.includes('/')
	}
	return isVisibilityGatedAnonymousPath(pathname)
}

export function requestHasSessionCookie(request: Request): boolean {
	const cookie = request.headers.get('Cookie') ?? ''
	return /(?:^|;\s*)kody_session=/.test(cookie)
}

export function requestHasRetiredSiteBannerDismissCookie(
	request: Request,
): boolean {
	const cookie = request.headers.get('Cookie') ?? ''
	return new RegExp(`(?:^|;\\s*)${retiredSiteBannerDismissCookieName}=`).test(
		cookie,
	)
}

export function clearRetiredSiteBannerDismissCookie(input: {
	secure: boolean
}): string {
	const secure = input.secure ? '; Secure' : ''
	return `${retiredSiteBannerDismissCookieName}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly${secure}`
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
	// Frame reloads share the page URL. Caching that response stores the
	// document where the frame expected a fragment.
	if (requestBypassesAnonymousDocumentCache(input.request)) {
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
