import { isPrefetchAbortSignal } from '#client/intent-prefetch.ts'
import { lastUsedOrgCommitApiPath } from '#universal/org-last-used-cookie.ts'
import { orgSlugFromOrgOwnedPath } from '#universal/org-pages.ts'

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
 * Destination page keys (`pathname+search`) whose speculative account JSON
 * skipped `kody_last_org`. A committed navigation that adopts that prefetch
 * removes its own key and writes the cookie for that page only.
 */
const pendingPrefetchLastUsedPages = new Set<string>()

function pageKeyFromHref(href: string, origin = 'https://kody.local') {
	const url = new URL(
		href,
		typeof window !== 'undefined' ? window.location.origin : origin,
	)
	return `${url.pathname}${url.search}`
}

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
		pendingPrefetchLastUsedPages.add(pageKeyFromHref(referrer))
	}
	return {
		headers,
		credentials: 'include',
		referrer,
		signal,
	}
}

/**
 * After the client router adopts a prefetch and commits that destination, the
 * adopted response was served with `X-Kody-Prefetch` and never wrote
 * `kody_last_org`. Hit the dedicated last-used commit JSON (not the section
 * twin) so the navigation e2e still sees one section payload and grant-only
 * collaborators are not section-denied (#3517).
 *
 * `signal` only gates whether we start the write (aborted nav never committed).
 * The fetch itself is not aborted: a follow-up hop must not cancel the cookie
 * for an org page the user already opened (e.g. org → personal).
 */
export function commitLastUsedOrgAfterPrefetchAdopt(
	pageHref: string,
	signal?: AbortSignal,
) {
	const key = pageKeyFromHref(pageHref)
	if (!pendingPrefetchLastUsedPages.has(key)) return
	// Drop the pending entry either way: this navigation adopted the prefetch.
	pendingPrefetchLastUsedPages.delete(key)
	if (signal?.aborted) return
	const pageUrl = new URL(pageHref, window.location.origin)
	if (orgSlugFromOrgOwnedPath(pageUrl.pathname) == null) return
	void fetch(lastUsedOrgCommitApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		referrer: pageUrl.href,
	}).then(
		() => {},
		() => {},
	)
}

/** Clears prefetch-skip bookkeeping (tests). */
export function resetOrgAccountPrefetchCookieState() {
	pendingPrefetchLastUsedPages.clear()
}

export { lastUsedOrgCommitApiPath }
