import { isRoutePrefetchInFlight } from '#client/intent-prefetch.ts'

/**
 * Fetch `referrer` for an org-owned `/account/<section>.json` load. The route
 * binds the org from the Referer, and a route loader runs before the router
 * commits the URL, so the default Referer would name the source page (the
 * previous org on an SPA org switch). Name the destination page instead.
 */
export function orgAccountApiReferrer(href: string) {
	return new URL(href, window.location.origin).href
}

/** Header the org-binding guard uses to skip last-used cookie on speculative loads. */
export const orgAccountPrefetchHeader = 'X-Kody-Prefetch'

/**
 * Shared fetch init for org-owned account JSON. Marks intent/render prefetches
 * so the server does not treat a hover as a last-used org commit (#3517).
 */
export function orgAccountApiFetchInit(
	href: string,
	signal?: AbortSignal,
): RequestInit {
	const headers: Record<string, string> = { Accept: 'application/json' }
	if (isRoutePrefetchInFlight()) {
		headers[orgAccountPrefetchHeader] = '1'
	}
	return {
		headers,
		credentials: 'include',
		referrer: orgAccountApiReferrer(href),
		signal,
	}
}
