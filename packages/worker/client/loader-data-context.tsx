import { type Handle, type RemixNode } from 'remix/ui'
import { tryConsumePreloadedLoaderData } from '#client/navigation-data.ts'
import { readSsrRouterUrl } from '#client/router-location.tsx'
import { type AppLoaderData } from '#app/loader-data.ts'

export type AppLoaderDataContextValue = {
	loaderData?: AppLoaderData
	consumedKeys: Set<keyof AppLoaderData>
}

const routerHrefOrigin = 'https://kody.local'

export function normalizeRouterHref(href: string) {
	const url = new URL(href, routerHrefOrigin)
	return `${url.pathname}${url.search}${url.hash}`
}

export function hrefMatchesSsrUrl(currentHref: string, ssrUrl: string) {
	return normalizeRouterHref(currentHref) === normalizeRouterHref(ssrUrl)
}

export function AppLoaderDataProvider(
	handle: Handle<
		{ loaderData?: AppLoaderData; children?: RemixNode },
		AppLoaderDataContextValue
	>,
) {
	const consumedKeys = new Set<keyof AppLoaderData>()
	handle.context.set({
		loaderData: handle.props.loaderData,
		consumedKeys,
	})

	return () => handle.props.children
}

/**
 * Returns SSR-embedded loader data for `key` only when `currentHref` matches
 * the document's SSR URL and this key has not been consumed yet. Successful
 * reads mark the key consumed so SPA navigations always refetch.
 *
 * Callers must run their own URL/path guards **before** calling this helper.
 * Consumption is irreversible; if a guard rejects after a successful read the
 * embedded payload is lost and the route can render a permanent loading state.
 */
export function tryConsumeEmbeddedLoaderData<K extends keyof AppLoaderData>(
	handle: Handle,
	key: K,
	currentHref: string,
): AppLoaderData[K] | undefined {
	const ctx = handle.context.get(AppLoaderDataProvider)
	const embedded = ctx.loaderData?.[key]
	if (!embedded) return undefined

	let ssrUrl: string
	try {
		ssrUrl = readSsrRouterUrl(handle)
	} catch {
		return undefined
	}

	if (!hrefMatchesSsrUrl(currentHref, ssrUrl)) return undefined
	if (ctx.consumedKeys.has(key)) return undefined

	ctx.consumedKeys.add(key)
	return embedded
}

/**
 * Returns loader data for `key` from SSR-embedded props or a preloaded SPA
 * navigation slot. Each source is consume-once per key.
 */
export function tryConsumeRouteLoaderData<K extends keyof AppLoaderData>(
	handle: Handle,
	key: K,
	currentHref: string,
): AppLoaderData[K] | undefined {
	const embedded = tryConsumeEmbeddedLoaderData(handle, key, currentHref)
	if (embedded !== undefined) return embedded
	return tryConsumePreloadedLoaderData(key, currentHref)
}
