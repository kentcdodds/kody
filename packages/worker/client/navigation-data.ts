import { type AppLoaderData } from '#universal/loader-data.ts'

const routerHrefOrigin = 'https://kody.local'

function normalizeNavigationHref(href: string) {
	const url = new URL(href, routerHrefOrigin)
	return `${url.pathname}${url.search}`
}

let preloadedSlot: { href: string; data: Partial<AppLoaderData> } | null = null

export function setPreloadedNavigationData(
	href: string,
	data: Partial<AppLoaderData>,
): void {
	preloadedSlot = {
		href: normalizeNavigationHref(href),
		data: { ...data },
	}
}

export function tryConsumePreloadedLoaderData<K extends keyof AppLoaderData>(
	key: K,
	href: string,
): AppLoaderData[K] | undefined {
	if (!preloadedSlot) return undefined
	if (normalizeNavigationHref(href) !== preloadedSlot.href) return undefined

	const value = preloadedSlot.data[key]
	if (value === undefined) return undefined

	delete preloadedSlot.data[key]
	if (Object.keys(preloadedSlot.data).length === 0) {
		preloadedSlot = null
	}
	return value
}

let staleNavigationHref: string | null = null

/**
 * Records that a navigation to `href` committed without preloaded data
 * because its route loader failed. Routes whose href-based freshness checks
 * cannot detect same-path refreshes (form POST redirects back to the current
 * URL) consume this marker to force a fallback refetch instead of silently
 * rendering stale, pre-mutation data.
 */
export function markNavigationDataStale(href: string): void {
	staleNavigationHref = normalizeNavigationHref(href)
}

/**
 * One-shot: returns whether `href` was marked stale, clearing the marker
 * either way. A mismatched href means the user navigated somewhere else,
 * where href-change freshness checks already force a refetch.
 */
export function consumeStaleNavigationData(href: string): boolean {
	if (staleNavigationHref === null) return false
	const isStale = staleNavigationHref === normalizeNavigationHref(href)
	staleNavigationHref = null
	return isStale
}

/** Test helper — clears the single-slot preloaded navigation store. */
export function clearPreloadedNavigationData() {
	preloadedSlot = null
	staleNavigationHref = null
}
