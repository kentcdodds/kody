/**
 * Scroll restoration storage and the pre-hydration restore script.
 *
 * Mirrors React Router's `<ScrollRestoration />`: positions are a
 * `{ [historyKey]: y }` map in sessionStorage, and an inline script in the
 * SSR body applies `window.scrollTo` before paint so a refresh does not flash
 * the top of the page. When there is no saved Y, the same script scrolls an
 * expanded list/detail record (`[data-record-focus]`) into view so a deep
 * link does not strand the reader at the toolbar.
 */

export const scrollRestorationStorageKey = 'kody:router-scroll-positions'

/** History state field React Router uses (`window.history.state.key`). */
export const historyStateScrollKey = 'key'

/**
 * Expanded list/detail record (the selected accordion row, or the off-window
 * pane). RecordTable marks the focused element; scroll restoration finds it.
 */
export const recordFocusSelector = '[data-record-focus]'

/**
 * Selected list/detail id whose record has not rendered yet. Restoration
 * retries while this is present so a client-loaded detail can still land on
 * the row; it must not be set for a not-found selection or a plain list.
 */
export const recordFocusPendingSelector = '[data-record-focus-pending]'

export function isRecordFocusInViewport(
	rect: { top: number; bottom: number },
	viewportHeight: number,
): boolean {
	return rect.bottom > 0 && rect.top < viewportHeight
}

export type SavedScrollPositions = Record<string, number>

export function parseSavedScrollPositions(
	raw: string | null,
): SavedScrollPositions {
	if (!raw) return {}
	try {
		const parsed: unknown = JSON.parse(raw)
		if (
			typeof parsed !== 'object' ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			return {}
		}
		const positions: SavedScrollPositions = {}
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value === 'number') {
				positions[key] = value
			}
		}
		return positions
	} catch {
		return {}
	}
}

export function serializeSavedScrollPositions(
	positions: SavedScrollPositions,
): string {
	return JSON.stringify(positions)
}

export function getStoredScrollY(
	positions: SavedScrollPositions,
	historyKey: string | null | undefined,
): number | null {
	if (!historyKey) return null
	const storedY = positions[historyKey]
	return typeof storedY === 'number' ? storedY : null
}

/**
 * Blocking classic script inlined in the SSR body. Keep this a string (not a
 * function that references `window`) so `#universal` stays DOM-free. The body
 * matches React Router's restore IIFE, plus `manual` scroll restoration so
 * the browser does not undo the pre-paint scroll.
 *
 * CSP allows this exact source via `scrollRestorationInlineScriptCspHash`.
 * Update the hash in the same change if you edit the script (the node test
 * fails when they drift).
 */
export const scrollRestorationInlineScript = `(function(storageKey,restoreKey,focusSelector){if("scrollRestoration"in window.history){window.history.scrollRestoration="manual"}if(!window.history.state||!window.history.state.key){var key=Math.random().toString(32).slice(2);window.history.replaceState({key:key},"")}try{var positions=JSON.parse(sessionStorage.getItem(storageKey)||"{}");var storedY=positions[restoreKey||window.history.state.key];if(typeof storedY==="number"){window.scrollTo(0,storedY)}else{var focus=document.querySelector(focusSelector);if(focus){var rect=focus.getBoundingClientRect();if(rect.bottom<=0||rect.top>=(window.innerHeight||document.documentElement.clientHeight)){focus.scrollIntoView()}}}}catch(error){console.error(error);sessionStorage.removeItem(storageKey)}})(${JSON.stringify(scrollRestorationStorageKey)},null,${JSON.stringify(recordFocusSelector)})`

export function getScrollRestorationInlineScript() {
	return scrollRestorationInlineScript
}

/**
 * `script-src` hash for `scrollRestorationInlineScript`. The node test
 * recomputes this so the CSP entry cannot drift from the inlined source.
 */
export const scrollRestorationInlineScriptCspHash =
	"'sha256-hu1YzSN8F+E24qB5qP7wHk5dggQsLaY3kL4e8tv6jOY='"
