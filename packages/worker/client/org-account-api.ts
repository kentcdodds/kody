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
 * Destination page referrer from the latest prefetch marked with
 * {@link orgAccountPrefetchHeader}. Cleared when a navigation adopts that
 * prefetch and commits last-used via {@link commitLastUsedOrgAfterPrefetchAdopt}.
 */
let pendingPrefetchLastUsedReferrer: string | null = null

/**
 * Shared fetch init for org-owned account JSON. Marks intent/render prefetches
 * so the server does not treat a hover as a last-used org commit (#3517).
 * Prefetch is detected from the loader's AbortSignal so an overlapping real
 * navigation cannot inherit the header from a global depth counter.
 */
export function orgAccountApiFetchInit(
	href: string,
	signal?: AbortSignal,
): RequestInit {
	const headers: Record<string, string> = { Accept: 'application/json' }
	const referrer = orgAccountApiReferrer(href)
	if (isPrefetchAbortSignal(signal)) {
		headers[orgAccountPrefetchHeader] = '1'
		pendingPrefetchLastUsedReferrer = referrer
	}
	return {
		headers,
		credentials: 'include',
		referrer,
		signal,
	}
}

/**
 * After the client router adopts a prefetch, the response was served with
 * `X-Kody-Prefetch` and never wrote `kody_last_org`. Fire a lightweight
 * org-owned JSON GET with the same destination Referer so the binding guard
 * commits last-used for the navigation that actually landed.
 */
export function commitLastUsedOrgAfterPrefetchAdopt() {
	const referrer = pendingPrefetchLastUsedReferrer
	pendingPrefetchLastUsedReferrer = null
	if (!referrer) return
	const url = new URL('/account/waiting.json', window.location.origin)
	void fetch(url, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		referrer,
	}).then(
		() => {},
		() => {},
	)
}
