import { type RouteLoader, type RouteLoaderResult } from './route-loader.ts'

const routerHrefOrigin = 'https://kody.local'

/**
 * How long a settled prefetch stays consumable. Covers the usual
 * hover-read-then-click gap while keeping the staleness window bounded:
 * navigations that consume a prefetch skip the loader entirely, so older
 * data would be shown as-is. Form POSTs abort pending prefetches, so
 * mutations never serve pre-mutation data regardless of this window.
 */
export const maxPrefetchAgeMs = 30_000

function normalizePrefetchHref(href: string) {
	const url = new URL(href, routerHrefOrigin)
	return `${url.pathname}${url.search}${url.hash}`
}

// Monotonic clock: freshness math must not break when the wall clock is
// adjusted (NTP sync, suspend/resume).
function monotonicNow() {
	return performance.now()
}

type PrefetchSlot = {
	href: string
	promise: Promise<RouteLoaderResult>
	controller: AbortController
	settledAt: number | null
	failed: boolean
}

// Single slot: the latest intent wins, mirroring the router's latest-wins
// navigation semantics and keeping at most one speculative request in flight.
let slot: PrefetchSlot | null = null

/**
 * Starts (or reuses) a speculative loader run for a link the user showed
 * intent for. Re-invoking for the same href while the previous run is in
 * flight or still fresh is a no-op; a different href aborts the previous run.
 */
export function prefetchRouteOnIntent(
	href: string,
	loader: RouteLoader,
	url: URL,
): void {
	const normalized = normalizePrefetchHref(href)
	if (slot && slot.href === normalized && !slot.failed) {
		if (
			slot.settledAt === null ||
			monotonicNow() - slot.settledAt <= maxPrefetchAgeMs
		) {
			return
		}
	}

	slot?.controller.abort()
	const controller = new AbortController()
	const nextSlot: PrefetchSlot = {
		href: normalized,
		promise: loader(url, controller.signal),
		controller,
		settledAt: null,
		failed: false,
	}
	slot = nextSlot
	nextSlot.promise.then(
		() => {
			nextSlot.settledAt = monotonicNow()
		},
		() => {
			nextSlot.settledAt = monotonicNow()
			nextSlot.failed = true
		},
	)
}

/**
 * Consumes the prefetched loader result for `href`. Returns the in-flight or
 * fresh settled promise, or `null` when there is no usable prefetch (wrong
 * href, expired, or failed — failures let the navigation retry the loader).
 * Consumption is one-shot. A mismatched href also aborts and clears the slot:
 * the user navigated somewhere other than the prefetched link, so the
 * speculative result must not survive to be adopted by a later navigation.
 * When `signal` aborts (a superseding navigation), a still-running prefetch
 * request is aborted with it.
 */
export function takePrefetchedRouteResult(
	href: string,
	signal?: AbortSignal,
): Promise<RouteLoaderResult> | null {
	if (!slot) return null
	if (slot.href !== normalizePrefetchHref(href)) {
		abortIntentPrefetch()
		return null
	}

	const current = slot
	slot = null
	if (current.failed) return null
	if (
		current.settledAt !== null &&
		monotonicNow() - current.settledAt > maxPrefetchAgeMs
	) {
		return null
	}
	signal?.addEventListener('abort', () => current.controller.abort(), {
		once: true,
	})
	return current.promise
}

/**
 * Aborts and clears any pending intent prefetch. Called after form POST
 * mutations so speculative pre-mutation data is never shown, and by tests.
 */
export function abortIntentPrefetch(): void {
	slot?.controller.abort()
	slot = null
}
