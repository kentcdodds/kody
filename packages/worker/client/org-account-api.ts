import { isPrefetchAbortSignal } from '#client/intent-prefetch.ts'

/**
 * Fetch `referrer` for an org-owned `/account/<section>.json` load. The route
 * binds the org from the Referer, and a route loader runs before the router
 * commits the URL, so the default Referer would name the source page (the
 * previous org on an SPA org switch). Name the destination page instead.
 */
function orgAccountApiReferrer(href: string) {
	return new URL(href, window.location.origin).href
}

/** Header the org-binding guard uses to skip last-used cookie on speculative loads. */
const orgAccountPrefetchHeader = 'X-Kody-Prefetch'

/**
 * Shared fetch init for org-owned account JSON. Marks intent/render prefetches
 * so the server does not treat a hover as a last-used org commit (#3517).
 * Prefetch is detected from the loader's AbortSignal so an overlapping real
 * navigation cannot inherit the header from a global depth counter.
 *
 * Org navigations do not adopt those prefetches: the router re-runs the loader
 * on commit so this init runs without the header and the guard writes
 * `kody_last_org` without a second section JSON round-trip.
 */
export function orgAccountApiFetchInit(
	href: string,
	signal?: AbortSignal,
): RequestInit {
	const headers: Record<string, string> = { Accept: 'application/json' }
	const referrer = orgAccountApiReferrer(href)
	if (isPrefetchAbortSignal(signal)) {
		headers[orgAccountPrefetchHeader] = '1'
	}
	return {
		headers,
		credentials: 'include',
		referrer,
		signal,
	}
}
