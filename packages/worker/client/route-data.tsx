import { type Handle, css } from 'remix/ui'
import { type AppLoaderData } from '#universal/loader-data.ts'
import { visuallyHiddenCss } from '#universal/styles/style-primitives.ts'
import {
	normalizeRouterHref,
	tryConsumeRouteLoaderData,
} from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'

/**
 * Route data with content continuity across navigations.
 *
 * The client router runs a route's loader *before* it commits the URL swap,
 * so on the happy path a route re-renders already holding the next payload
 * (SSR-embedded on the first document, preloaded by the router on SPA
 * navigations) and the previous content is replaced in one DOM commit —
 * nothing is blanked, no loading state is shown.
 *
 * This helper owns everything around that path so a route cannot reintroduce
 * a flash loader by accident:
 *
 * - consume-once of the route's loader-data key(s) for the current location
 * - the href latch that decides when a *fallback* fetch is needed (the
 *   router's loader failed, a stale refresh after a form POST, a cold SPA
 *   mount without SSR data) and never re-queues an in-flight one
 * - the abort-safe `queueTask` fetch, with late completions for a location
 *   the user already left dropped on the floor
 * - the "last good payload" the route keeps rendering while that fallback
 *   fetch runs, so the page never empties out mid-navigation
 *
 * Routes call `read(handle, currentHref)` once per render and switch on the
 * snapshot. Render `snapshot.data` whenever it is non-null (with
 * `aria-busy` while `pending`, see `renderRoutePendingStatus`); reserve a
 * standalone loading message for `data === null`, which only happens when
 * there has never been anything to show.
 *
 * Routes that keep their own closure state (forms, selections, action
 * feedback) apply `snapshot.data` into that state when its identity changes
 * and otherwise leave their state model alone.
 */

export type RouteDataSnapshot<T> = {
	/**
	 * `ready`: `data` describes the current location.
	 * `pending`: a fallback fetch for the current location is in flight (or
	 * queued this render); `data` is the last good payload, possibly from the
	 * previous location (`stale`), or null when nothing was ever loaded.
	 * `not-found` / `error`: the fallback fetch for the current location
	 * settled that way.
	 */
	kind: 'ready' | 'pending' | 'not-found' | 'error'
	data: T | null
	/** `data` belongs to a different location than the one being rendered. */
	stale: boolean
	/** The failure behind `kind: 'error'`; null otherwise. */
	error: Error | null
}

const redirectMarker = Symbol('route-data-redirect')

type RouteDataRedirect = { [redirectMarker]: true; to: string }

/**
 * Return from `load` when the fetch answered with a session problem (401)
 * and the browser must leave for a full document (login). The route stays
 * on its current content while the document navigates away.
 */
export function routeDataRedirect(to: string): RouteDataRedirect {
	return { [redirectMarker]: true, to }
}

function isRouteDataRedirect(value: unknown): value is RouteDataRedirect {
	return typeof value === 'object' && value !== null && redirectMarker in value
}

export type RouteDataLoadResult<T> = T | null | RouteDataRedirect

type RouteDataSource<K extends keyof AppLoaderData, T> =
	| {
			/** Loader-data key the route's loader returns (`#universal/loader-data.ts`). */
			key: K
			/**
			 * Map a consumed loader payload to route data. Defaults to the
			 * payload itself when it does not carry `ok: false`.
			 */
			fromLoaderData?: (payload: NonNullable<AppLoaderData[K]>) => T | null
			consume?: never
	  }
	| {
			key?: never
			fromLoaderData?: never
			/**
			 * Routes whose loader returns several keys assemble them here with
			 * `tryConsumeRouteLoaderData` (all-or-nothing: return null when a
			 * required key is missing so the fallback fetch loads the full set).
			 */
			consume: (handle: Handle, href: string) => T | null
	  }

type RouteDataOptions<K extends keyof AppLoaderData, T> = RouteDataSource<
	K,
	T
> & {
	/**
	 * Fallback fetch for `href`. Return `null` for a 404, `routeDataRedirect`
	 * for a session redirect, and throw for any other failure (the message
	 * surfaces as `snapshot.error`). Do not call `handle.update()` inside —
	 * the helper schedules the render once the result is applied.
	 */
	load: (href: string, signal: AbortSignal) => Promise<RouteDataLoadResult<T>>
	/**
	 * Which locations share one payload. Defaults to pathname + search. A
	 * list/detail route whose detail pages reuse the list payload maps them to
	 * the same key so moving between them is not a new load.
	 */
	locationKey?: (href: string) => string
}

function defaultFromLoaderData<T>(payload: unknown): T | null {
	if (
		typeof payload === 'object' &&
		payload !== null &&
		'ok' in payload &&
		payload.ok === false
	) {
		return null
	}
	return payload as T
}

export function createRouteData<
	K extends keyof AppLoaderData,
	T = NonNullable<AppLoaderData[K]>,
>(options: RouteDataOptions<K, T>) {
	const latch = createRouteLoadLatch()
	const toLocationKey = options.locationKey ?? normalizeRouterHref

	function consume(handle: Handle, currentHref: string): T | null {
		if (options.consume) return options.consume(handle, currentHref)
		const payload = tryConsumeRouteLoaderData(handle, options.key, currentHref)
		if (payload === undefined) return null
		const fromLoaderData =
			options.fromLoaderData ??
			((value: NonNullable<AppLoaderData[K]>) =>
				defaultFromLoaderData<T>(value))
		return fromLoaderData(payload as NonNullable<AppLoaderData[K]>)
	}

	let data: T | null = null
	/** Location key `data` / `outcome` describe. */
	let dataKey: string | null = null
	let outcome: 'ready' | 'not-found' | 'error' | null = null
	let error: Error | null = null
	/** Location key a fallback fetch is in flight for. */
	let pendingKey: string | null = null
	/** Location key of the latest render; late completions for others are dropped. */
	let renderedKey: string | null = null

	function queueFallbackLoad(handle: Handle, currentHref: string) {
		const key = toLocationKey(currentHref)
		const attempt = latch.getPendingAttempt()
		pendingKey = key

		// remix/ui aborts a queued task's signal whenever the component
		// re-renders for any reason (a shell session refresh, for example).
		// Release the latch so the next render may re-queue, and when the
		// route is still on this location, schedule that render ourselves —
		// otherwise nothing would, and the route would sit in `pending`.
		function handleAbort() {
			latch.clearPending(key, attempt)
			if (renderedKey === key && pendingKey === key) {
				void handle.update()
			}
		}

		handle.queueTask(async (signal) => {
			try {
				const result = await options.load(currentHref, signal)
				if (signal.aborted) {
					handleAbort()
					return
				}
				if (renderedKey !== key) return
				if (isRouteDataRedirect(result)) {
					// Leave the page as is; the document is about to change.
					window.location.assign(result.to)
					return
				}
				data = result
				dataKey = key
				outcome = result === null ? 'not-found' : 'ready'
				error = null
				pendingKey = null
				latch.markLoaded(key)
				void handle.update()
			} catch (caught) {
				if (signal.aborted) {
					handleAbort()
					return
				}
				if (renderedKey !== key) return
				data = null
				dataKey = key
				outcome = 'error'
				error = caught instanceof Error ? caught : new Error(String(caught))
				pendingKey = null
				latch.markFailed(key)
				void handle.update()
			}
		})
	}

	return {
		/** Call once per render with the router href the route is rendering. */
		read(handle: Handle, currentHref: string): RouteDataSnapshot<T> {
			const key = toLocationKey(currentHref)
			renderedKey = key

			const consumed = consume(handle, currentHref)
			const appliedRouteData = consumed !== null
			if (consumed !== null) {
				data = consumed
				dataKey = key
				outcome = 'ready'
				error = null
				pendingKey = null
			}

			const needsStaleRefresh = consumeStaleNavigationData(currentHref)
			const needsLoad = latch.needsLoad({
				currentHref: key,
				appliedRouteData,
				needsStaleRefresh,
			})
			if (needsLoad && typeof document !== 'undefined') {
				queueFallbackLoad(handle, currentHref)
			}

			const stale = data !== null && dataKey !== key
			if (pendingKey === key) {
				return { kind: 'pending', data, stale, error: null }
			}
			if (dataKey === key && outcome !== null) {
				return {
					kind: outcome,
					data: outcome === 'ready' ? data : null,
					stale,
					error: outcome === 'error' ? error : null,
				}
			}
			// Server render (or a client render before hydration) without a
			// payload for this location: nothing is in flight yet, but the
			// route still has nothing current to show.
			return { kind: 'pending', data, stale, error: null }
		},
		/**
		 * Fetch the current location again (after a mutation the route wants
		 * to reconcile with the server). The current payload stays on screen
		 * under `pending` until the fresh one lands. No-op while a fetch for
		 * this location is already in flight.
		 */
		reload(handle: Handle, currentHref: string) {
			if (typeof document === 'undefined') return
			const key = toLocationKey(currentHref)
			if (pendingKey === key) return
			latch.needsLoad({
				currentHref: key,
				appliedRouteData: false,
				needsStaleRefresh: true,
			})
			queueFallbackLoad(handle, currentHref)
			void handle.update()
		},
	}
}

/**
 * Screen-reader announcement for a route that keeps its last good content
 * on screen while a fallback fetch runs. Visually silent (the content and the
 * chrome stay exactly where they were, so there is nothing to lay out), but
 * assistive tech hears that the page is updating instead of being told a
 * stale page is the destination. Pair with `aria-busy` on the region.
 */
export function renderRoutePendingStatus(label = 'Loading…') {
	return (
		<p role="status" mix={css(visuallyHiddenCss)}>
			{label}
		</p>
	)
}
