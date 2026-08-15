const latchHrefOrigin = 'https://kody.local'

function toLatchKey(href: string) {
	const url = new URL(href, latchHrefOrigin)
	return `${url.pathname}${url.search}`
}

/**
 * Href latch for client routes that fetch their own data. Tracks which
 * location the data was last loaded for, which location last failed so a
 * failed load does not re-queue in a tight render loop but does retry after
 * navigating away and back, and which location is already pending so an
 * in-flight `queueTask` is not re-queued on every re-render.
 *
 * Keys are pathname+search only. In-page hashes (`/#invite`, onboarding step
 * hashes) are scroll/UI state, not a new data location.
 *
 * Why pending matters: Remix aborts a `queueTask` signal when the component
 * re-renders. A load that calls `handle.update()` before its first `await`
 * aborts itself, `needsLoad` stays true, and the next render queues another
 * load — cascading microtask flushes until the scheduler throws
 * `handle.update() infinite loop detected`. Marking pending on the first
 * `needsLoad` decision stops that re-queue. Callers must still avoid
 * premature `handle.update()` inside the queued load (set loading UI in the
 * render that decides to load instead). Aborted tasks must call
 * `clearPending(href, attempt)` with the attempt from `getPendingAttempt()`
 * so a late abort cannot clear a newer pending load for the same href.
 */
export function createRouteLoadLatch() {
	let lastLoadedHref = ''
	let lastFailedHref: string | null = null
	let lastPendingHref: string | null = null
	/** Monotonic id for the current pending load; abort clear must match it. */
	let pendingAttempt = 0
	let lastSeenHref = ''

	return {
		/** Record a successful load (or applied preloaded data) for `href`. */
		markLoaded(href: string) {
			const key = toLatchKey(href)
			// Ignore late completions after navigating away so they cannot
			// clobber the active location's loaded/pending markers. Allow
			// markLoaded before the first needsLoad (applied route data is
			// often recorded in the same render pass before needsLoad runs).
			if (lastSeenHref !== '' && key !== lastSeenHref) return
			lastLoadedHref = key
			lastFailedHref = null
			if (lastPendingHref === key) {
				lastPendingHref = null
			}
		},
		/** Record a failed load so renders stop re-queuing for this `href`. */
		markFailed(href: string) {
			const key = toLatchKey(href)
			if (lastSeenHref !== '' && key !== lastSeenHref) return
			lastFailedHref = key
			if (lastPendingHref === key) {
				lastPendingHref = null
			}
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
		 * Attempt id for the current pending href, captured right after
		 * `needsLoad` returns true. Pass it to `clearPending` so a late abort
		 * from an older queueTask cannot clear a newer pending attempt.
		 */
		getPendingAttempt() {
			return pendingAttempt
		},
		/**
		 * Drop the in-flight pending marker for `href` after an aborted
		 * `queueTask` so the next render can re-queue. Remix aborts the task
		 * signal on unrelated re-renders (e.g. shell session refresh); without
		 * this, pending would stick and the route would stay on loading UI.
		 * When `attempt` is provided, only clears if it still matches the
		 * active pending attempt.
		 */
		clearPending(href: string, attempt?: number) {
			const key = toLatchKey(href)
			if (lastPendingHref !== key) return
			if (attempt !== undefined && attempt !== pendingAttempt) return
			lastPendingHref = null
		},
		/**
		 * Whether the route must queue a data load this render pass. Call once
		 * per render with the current router href. A `true` result latches the
		 * href as pending until `markLoaded` / `markFailed` / `clearPending`
		 * (or a navigation / stale-refresh clears it). Read `getPendingAttempt()`
		 * immediately after a `true` result for abort-safe clearing.
		 *
		 * `isLoading` is accepted for call-site compatibility but ignored: the
		 * pending latch is the in-flight guard. Using `isLoading` as a reason
		 * *to* load re-queued every render while status stayed `'loading'`.
		 */
		needsLoad(input: {
			currentHref: string
			isLoading: boolean
			appliedRouteData: boolean
			needsStaleRefresh: boolean
		}) {
			void input.isLoading
			// The failure/pending latches only guard the location they were set
			// for; leaving it (or coming back) must allow a fresh attempt.
			const currentHref = toLatchKey(input.currentHref)
			if (currentHref !== lastSeenHref) {
				lastSeenHref = currentHref
				lastFailedHref = null
				lastPendingHref = null
			}
			// A stale-refresh signal is one-shot (the caller consumes it from
			// navigation state), so it represents a fresh user-driven reload and
			// must win over a previous failure or abandoned pending for the same
			// location.
			if (input.needsStaleRefresh) {
				lastFailedHref = null
				lastPendingHref = null
			}
			if (input.appliedRouteData) {
				return false
			}
			const shouldLoad =
				(currentHref !== lastLoadedHref || input.needsStaleRefresh) &&
				currentHref !== lastFailedHref &&
				currentHref !== lastPendingHref
			if (shouldLoad) {
				lastPendingHref = currentHref
				pendingAttempt += 1
			}
			return shouldLoad
		},
	}
}
