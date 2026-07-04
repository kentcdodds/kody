import { type AppLoaderData } from '#app/loader-data.ts'

const routerHrefOrigin = 'https://kody.local'

function normalizeNavigationHref(href: string) {
	const url = new URL(href, routerHrefOrigin)
	return `${url.pathname}${url.search}${url.hash}`
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

/** Test helper — clears the single-slot preloaded navigation store. */
export function clearPreloadedNavigationData() {
	preloadedSlot = null
}
