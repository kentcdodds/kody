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
	return `${url.pathname}${url.search}`
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
	retainRequest: boolean
}

// Single slot: the latest intent wins, mirroring the router's latest-wins
// navigation semantics and keeping at most one speculative request in flight.
let slot: PrefetchSlot | null = null

// Render prefetch: many destinations can stay warm at once (chip lists).
// A new href does not abort siblings. Shared fetches set `retainRequest` so
// adopting one destination cannot cancel the warmup the others still need.
const renderSlots = new Map<string, PrefetchSlot>()

function isUsablePrefetch(current: PrefetchSlot | null | undefined) {
	if (!current || current.failed) return false
	if (current.settledAt === null) return true
	return monotonicNow() - current.settledAt <= maxPrefetchAgeMs
}

function attachSettleHandlers(records: ReadonlyArray<PrefetchSlot>) {
	const [first] = records
	if (!first) return
	first.promise.then(
		() => {
			const settledAt = monotonicNow()
			for (const record of records) record.settledAt = settledAt
		},
		() => {
			const settledAt = monotonicNow()
			for (const record of records) {
				record.settledAt = settledAt
				record.failed = true
			}
		},
	)
}

function consumePrefetchSlot(
	current: PrefetchSlot,
	signal?: AbortSignal,
): Promise<RouteLoaderResult> | null {
	if (current.failed) return null
	if (
		current.settledAt !== null &&
		monotonicNow() - current.settledAt > maxPrefetchAgeMs
	) {
		return null
	}
	// Shared render warmups must outlive one navigation: aborting the fetch
	// would leave the remaining chip slots with a cancelled promise.
	if (!current.retainRequest) {
		signal?.addEventListener('abort', () => current.controller.abort(), {
			once: true,
		})
	}
	return current.promise
}

/**
 * Starts (or reuses) a speculative loader run for a link the user showed
 * intent for. Re-invoking for the same href while the previous run is in
 * flight or still fresh is a no-op; a different href aborts the previous run.
 * A fresh render-prefetch for the same href is also a no-op — hover must not
 * replace a list warmup that click still needs.
 */
export function prefetchRouteOnIntent(
	href: string,
	loader: RouteLoader,
	url: URL,
): void {
	const normalized = normalizePrefetchHref(href)
	if (isUsablePrefetch(renderSlots.get(normalized))) return
	if (isUsablePrefetch(slot) && slot?.href === normalized) return

	slot?.controller.abort()
	const controller = new AbortController()
	const nextSlot: PrefetchSlot = {
		href: normalized,
		promise: loader(url, controller.signal),
		controller,
		settledAt: null,
		failed: false,
		retainRequest: false,
	}
	slot = nextSlot
	attachSettleHandlers([nextSlot])
}

/**
 * Warms many destinations at once so a rendered list can be click-ready.
 * Destinations that share `loader` share one request — onboarding chips all
 * hit the same payload. Already-fresh hrefs are left alone.
 */
export function prefetchRoutesOnRender(
	hrefs: ReadonlyArray<string>,
	loader: RouteLoader,
	urlForHref: (href: string) => URL = (href) => new URL(href, routerHrefOrigin),
): void {
	const needed: Array<string> = []
	const seen = new Set<string>()
	for (const href of hrefs) {
		const normalized = normalizePrefetchHref(href)
		if (seen.has(normalized)) continue
		seen.add(normalized)
		if (isUsablePrefetch(renderSlots.get(normalized))) continue
		if (isUsablePrefetch(slot) && slot?.href === normalized) continue
		needed.push(normalized)
	}
	if (needed.length === 0) return

	const firstHref = needed[0]
	if (!firstHref) return
	const controller = new AbortController()
	const promise = loader(urlForHref(firstHref), controller.signal)
	const records = needed.map((href) => {
		const record: PrefetchSlot = {
			href,
			promise,
			controller,
			settledAt: null,
			failed: false,
			retainRequest: needed.length > 1,
		}
		renderSlots.set(href, record)
		return record
	})
	attachSettleHandlers(records)
}

/**
 * Consumes the prefetched loader result for `href`. Returns the in-flight or
 * fresh settled promise, or `null` when there is no usable prefetch (wrong
 * href, expired, or failed — failures let the navigation retry the loader).
 * Consumption is one-shot per href. A hover-intent miss aborts that slot so
 * it cannot be adopted later; other render-warmed destinations stay. When
 * `signal` aborts a non-shared prefetch, the in-flight request is cancelled.
 */
export function takePrefetchedRouteResult(
	href: string,
	signal?: AbortSignal,
): Promise<RouteLoaderResult> | null {
	const normalized = normalizePrefetchHref(href)

	if (slot && slot.href === normalized) {
		const current = slot
		slot = null
		return consumePrefetchSlot(current, signal)
	}

	const rendered = renderSlots.get(normalized)
	if (rendered) {
		renderSlots.delete(normalized)
		return consumePrefetchSlot(rendered, signal)
	}

	// Navigating away from the hover-intent destination drops that slot so it
	// cannot be adopted later. Render-warmed siblings stay — the list is still
	// one click away.
	if (slot) {
		slot.controller.abort()
		slot = null
	}
	return null
}

/**
 * Aborts and clears every speculative prefetch (hover-intent and render).
 * Called after form POST mutations so pre-mutation data is never shown, and
 * by tests.
 */
export function abortIntentPrefetch(): void {
	slot?.controller.abort()
	slot = null
	const aborted = new Set<AbortController>()
	for (const record of renderSlots.values()) {
		if (aborted.has(record.controller)) continue
		aborted.add(record.controller)
		record.controller.abort()
	}
	renderSlots.clear()
}
