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
 * - consume-once of the route's loader-data key for the current location
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
}

type RouteDataOptions<K extends keyof AppLoaderData, T> = {
	/** Loader-data key the route's loader returns (`#universal/loader-data.ts`). */
	key: K
	/**
	 * Fallback fetch for `href`. Return `null` for a 404; throw for any other
	 * failure. Do not call `handle.update()` inside — the helper schedules the
	 * render once the result is applied.
	 */
	load: (href: string, signal: AbortSignal) => Promise<T | null>
	/**
	 * Map a consumed loader payload to route data. Defaults to the payload
	 * itself when it does not carry `ok: false`.
	 */
	fromLoaderData?: (payload: NonNullable<AppLoaderData[K]>) => T | null
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
	const fromLoaderData =
		options.fromLoaderData ??
		((payload: NonNullable<AppLoaderData[K]>) =>
			defaultFromLoaderData<T>(payload))

	let data: T | null = null
	/** Location (pathname + search) `data` / `outcome` describe. */
	let dataHref: string | null = null
	let outcome: 'ready' | 'not-found' | 'error' | null = null
	/** Location a fallback fetch is in flight for. */
	let pendingHref: string | null = null
	/** Location of the latest render; late completions for others are dropped. */
	let renderedHref: string | null = null

	function applyLoaded(href: string, result: T | null) {
		dataHref = href
		data = result
		outcome = result === null ? 'not-found' : 'ready'
	}

	function queueFallbackLoad(handle: Handle, currentHref: string) {
		const href = normalizeRouterHref(currentHref)
		const attempt = latch.getPendingAttempt()
		pendingHref = href

		// remix/ui aborts a queued task's signal whenever the component
		// re-renders for any reason (a shell session refresh, for example).
		// Release the latch so the next render may re-queue, and when the
		// route is still on this location, schedule that render ourselves —
		// otherwise nothing would, and the route would sit in `pending`.
		function handleAbort() {
			latch.clearPending(currentHref, attempt)
			if (renderedHref === href && pendingHref === href) {
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
				if (renderedHref !== href) return
				applyLoaded(href, result)
				pendingHref = null
				latch.markLoaded(currentHref)
				void handle.update()
			} catch {
				if (signal.aborted) {
					handleAbort()
					return
				}
				if (renderedHref !== href) return
				data = null
				dataHref = href
				outcome = 'error'
				pendingHref = null
				latch.markFailed(currentHref)
				void handle.update()
			}
		})
	}

	return {
		/** Call once per render with the router href the route is rendering. */
		read(handle: Handle, currentHref: string): RouteDataSnapshot<T> {
			const href = normalizeRouterHref(currentHref)
			renderedHref = href

			const payload = tryConsumeRouteLoaderData(
				handle,
				options.key,
				currentHref,
			)
			let appliedRouteData = false
			if (payload !== undefined) {
				const selected = fromLoaderData(
					payload as NonNullable<AppLoaderData[K]>,
				)
				if (selected !== null) {
					data = selected
					dataHref = href
					outcome = 'ready'
					pendingHref = null
					appliedRouteData = true
				}
			}

			const needsStaleRefresh = consumeStaleNavigationData(currentHref)
			const needsLoad = latch.needsLoad({
				currentHref,
				appliedRouteData,
				needsStaleRefresh,
			})
			if (needsLoad && typeof document !== 'undefined') {
				queueFallbackLoad(handle, currentHref)
			}

			const stale = data !== null && dataHref !== href
			if (pendingHref === href) {
				return { kind: 'pending', data, stale }
			}
			if (dataHref === href && outcome !== null) {
				return { kind: outcome, data: outcome === 'ready' ? data : null, stale }
			}
			// Server render (or a client render before hydration) without a
			// payload for this location: nothing is in flight yet, but the
			// route still has nothing current to show.
			return { kind: 'pending', data, stale }
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
