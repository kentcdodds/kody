const latchHrefOrigin = 'https://kody.local'

function toLatchKey(href: string) {
	const url = new URL(href, latchHrefOrigin)
	return `${url.pathname}${url.search}`
}

/**
 * Href latch for client routes that fetch their own data. Tracks which
 * location the data was last loaded for, and which location last failed so a
 * failed load does not re-queue in a tight render loop but does retry after
 * navigating away and back (previously a failure latched these routes into a
 * permanent error state because the loaded-href marker was set before the
 * fetch resolved).
 *
 * Keys are pathname+search only. In-page hashes (`/#invite`, onboarding step
 * hashes) are scroll/UI state, not a new data location.
 */
export function createRouteLoadLatch() {
	let lastLoadedHref = ''
	let lastFailedHref: string | null = null
	let lastSeenHref = ''

	return {
		/** Record a successful load (or applied preloaded data) for `href`. */
		markLoaded(href: string) {
			lastLoadedHref = toLatchKey(href)
			lastFailedHref = null
		},
		/** Record a failed load so renders stop re-queuing for this `href`. */
		markFailed(href: string) {
			const key = toLatchKey(href)
			lastFailedHref = key
			// A failure supersedes any earlier success for the same location;
			// otherwise a failed refresh would leave the route latched as
			// loaded and never refetch after navigating away and back.
			if (lastLoadedHref === key) {
				lastLoadedHref = ''
			}
		},
		/** Whether the last successful load matches `href`. */
		isLoadedFor(href: string) {
			return lastLoadedHref === toLatchKey(href)
		},
		/**
		 * Whether the route must queue a data load this render pass. Call once
		 * per render with the current router href.
		 */
		needsLoad(input: {
			currentHref: string
			isLoading: boolean
			appliedRouteData: boolean
			needsStaleRefresh: boolean
		}) {
			// The failure latch only guards retry loops for the location that
			// failed; leaving it (or coming back) must allow a fresh attempt.
			const currentHref = toLatchKey(input.currentHref)
			if (currentHref !== lastSeenHref) {
				lastSeenHref = currentHref
				lastFailedHref = null
			}
			// A stale-refresh signal is one-shot (the caller consumes it from
			// navigation state), so it represents a fresh user-driven reload and
			// must win over a previous failure for the same location.
			if (input.needsStaleRefresh) {
				lastFailedHref = null
			}
			return (
				!input.appliedRouteData &&
				(input.isLoading ||
					currentHref !== lastLoadedHref ||
					input.needsStaleRefresh) &&
				currentHref !== lastFailedHref
			)
		},
	}
}
