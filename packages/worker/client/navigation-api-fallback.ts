/**
 * Minimal stand-in for the Navigation API, installed only where the browser
 * does not provide one.
 *
 * Remix 3 beta's client runtime reads `window.navigation.updateCurrentEntry()`
 * unguarded while it boots (`@remix-run/ui`'s `startNavigationListener`), so
 * `run()` throws on every browser without the Navigation API. The API only
 * reached Firefox in 147 and WebKit in 26.2, both in early 2026, so that still
 * covers Firefox 146 and below plus every browser on iOS 26.1 and below — all
 * of them WebKit, so Chrome for iOS and in-app browsers included.
 *
 * The throw lands after `createFrame(...)` but before `run()` returns, so
 * hydration already in flight survives and the app stays broadly usable. What
 * those visitors actually lose is an unhandled `TypeError` on every page load,
 * plus the `app.addEventListener('error', ...)` wiring and `app.ready()` call
 * in `entry.tsx` that never run — meaning client error reporting is missing
 * for exactly the people already hitting an error.
 *
 * Kody itself never uses the Navigation API: `client-router.tsx` drives SPA
 * navigation through `history.pushState` and a document-level click handler,
 * and it calls `preventDefault()` before the Remix listener could intercept
 * anything. A stand-in that never emits `navigate` is therefore equivalent to
 * the real API for this app, and the links Remix would have intercepted fall
 * back to ordinary document navigation.
 *
 * Only the members the Remix runtime touches are implemented. Remove this once
 * the upstream guard ships: https://github.com/remix-run/remix/issues/11641
 */

type FallbackHistoryEntry = {
	readonly key: string
	readonly id: string
	readonly url: string
	readonly index: number
	readonly sameDocument: boolean
	getState: () => unknown
}

type FallbackNavigateOptions = {
	state?: unknown
	history?: 'auto' | 'push' | 'replace'
}

const fallbackEntryKey = 'kody-navigation-fallback'

class NavigationApiFallback extends EventTarget {
	#window: Window
	#state: unknown = null

	constructor(win: Window) {
		super()
		this.#window = win
	}

	get currentEntry(): FallbackHistoryEntry {
		return {
			key: fallbackEntryKey,
			id: fallbackEntryKey,
			url: this.#window.location.href,
			index: 0,
			sameDocument: true,
			getState: () => this.#state,
		}
	}

	entries(): Array<FallbackHistoryEntry> {
		return [this.currentEntry]
	}

	updateCurrentEntry(options: { state?: unknown }) {
		this.#state = options?.state ?? null
	}

	navigate(url: string, options?: FallbackNavigateOptions) {
		this.#state = options?.state ?? null
		const destination = new URL(url, this.#window.location.href).toString()
		if (options?.history === 'replace') {
			this.#window.location.replace(destination)
		} else {
			this.#window.location.assign(destination)
		}
		// Cross-document navigations discard this document, so the real API
		// never settles these promises either.
		const pending = new Promise<FallbackHistoryEntry>(() => {})
		return { committed: pending, finished: pending }
	}
}

/**
 * Defines `window.navigation` when the browser lacks it.
 *
 * @returns whether the fallback was installed.
 */
export function installNavigationApiFallback(win: Window) {
	if (win.navigation) return false

	try {
		Object.defineProperty(win, 'navigation', {
			// Only the subset Remix reads is implemented, so the real
			// `Navigation` type overstates what this provides.
			value: new NavigationApiFallback(win) as unknown as Navigation,
			configurable: true,
			writable: true,
			enumerable: false,
		})
	} catch {
		// A browser that refuses the definition still gets the unguarded
		// upstream throw; failing to install must not add a second error.
		return false
	}

	return true
}
