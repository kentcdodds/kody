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
	return `${url.pathname}${url.search}`
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
 * the document's SSR URL (pathname + search; hashes are ignored) and this key
 * has not been consumed yet. Successful reads mark the key consumed so SPA
 * navigations always refetch.
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
 * Consumption happens mid-render and the caller applies the payload by
 * mutating route closure state, so anything the route derived earlier in the
 * same render pass is stale. Schedule one follow-up render so the route
 * re-derives everything from the applied data. The scheduler flushes queued
 * tasks and the resulting update in the same microtask as the current render
 * (before the browser paints), and consume-once semantics guarantee the
 * follow-up pass consumes nothing, so this cannot loop. `queueTask` (not a
 * direct `update()`) because a component's update scheduling is not wired
 * until its first render returns; on the server `queueTask` is a no-op.
 */
function scheduleCorrectiveRender(handle: Handle) {
	handle.queueTask(() => {
		void handle.update()
	})
}

/**
 * Returns loader data for `key` from SSR-embedded props or a preloaded SPA
 * navigation slot. Each source is consume-once per key. Successful reads
 * schedule a follow-up render of the consuming component so values derived
 * before consumption in the same render pass cannot persist stale.
 */
export function tryConsumeRouteLoaderData<K extends keyof AppLoaderData>(
	handle: Handle,
	key: K,
	currentHref: string,
): AppLoaderData[K] | undefined {
	const embedded = tryConsumeEmbeddedLoaderData(handle, key, currentHref)
	const data =
		embedded !== undefined
			? embedded
			: tryConsumePreloadedLoaderData(key, currentHref)
	if (data !== undefined) {
		scheduleCorrectiveRender(handle)
	}
	return data
}
