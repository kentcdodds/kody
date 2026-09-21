import { locationWithoutHomeOgParam } from '#universal/home-og-variants.ts'
import { syncLastNotifiedDocumentPath } from './client-router.tsx'

/**
 * Drop `og` from the address bar after the page has loaded. Crawlers that
 * only read the first HTML still see the variant meta. Other params and the
 * hash stay. `replaceState` does not fire `popstate`.
 */
export function stripHomeOgQueryFromLocation(): boolean {
	if (typeof window === 'undefined') return false
	try {
		const next = locationWithoutHomeOgParam(window.location.href)
		if (!next) return false
		window.history.replaceState(window.history.state, '', next)
		syncLastNotifiedDocumentPath()
		return true
	} catch {
		return false
	}
}
