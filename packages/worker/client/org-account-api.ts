/**
 * Fetch `referrer` for an org-owned `/account/<section>.json` load. The route
 * binds the org from the Referer, and a route loader runs before the router
 * commits the URL, so the default Referer would name the source page (the
 * previous org on an SPA org switch). Name the destination page instead.
 */
function orgAccountApiReferrer(href: string) {
	return new URL(href, window.location.origin).href
}

/** Shared fetch init for org-owned account JSON. */
export function orgAccountApiFetchInit(
	href: string,
	signal?: AbortSignal,
): RequestInit {
	return {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		referrer: orgAccountApiReferrer(href),
		signal,
	}
}
