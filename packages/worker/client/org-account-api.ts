/**
 * Fetch `referrer` for an org-owned `/account/<section>.json` load. The route
 * binds the org from the Referer, and a route loader runs before the router
 * commits the URL, so the default Referer would name the source page (the
 * previous org on an SPA org switch). Name the destination page instead.
 */
export function orgAccountApiReferrer(href: string) {
	return new URL(href, window.location.origin).href
}
