/**
 * Remix 3 `run()` calls `window.navigation.updateCurrentEntry` during boot.
 * The Navigation API is missing on Safari < 26.2, every iOS Chrome / Twitter
 * WKWebView, and Firefox < 147. Kody's client router already owns SPA
 * navigation via `history.pushState`, so a stub is enough to let hydration
 * start. This is not a full Navigation API polyfill.
 */
export type NavigationApiHost = {
	navigation?: {
		updateCurrentEntry?: (options?: { state?: unknown }) => void
	} | null
	location?: {
		href: string
		assign: (url: string | URL) => void
		replace: (url: string | URL) => void
	}
}

type NavigationHistoryEntryLike = {
	key: string
	id: string
	url: string
	index: number
	sameDocument: boolean
	getState: () => unknown
}

type NavigationResultLike = {
	committed: Promise<NavigationHistoryEntryLike>
	finished: Promise<NavigationHistoryEntryLike>
}

function createSettledResult(
	entry: NavigationHistoryEntryLike,
): NavigationResultLike {
	const committed = Promise.resolve(entry)
	return { committed, finished: committed }
}

function createHistoryEntry(
	url: string,
	state: unknown = null,
): NavigationHistoryEntryLike {
	return {
		key: 'kody-navigation-stub',
		id: 'kody-navigation-stub',
		url,
		index: 0,
		sameDocument: true,
		getState: () => state,
	}
}

export function ensureNavigationApi(
	host: NavigationApiHost | undefined = typeof window === 'undefined'
		? undefined
		: (window as NavigationApiHost),
): void {
	if (!host) return
	if (typeof host.navigation?.updateCurrentEntry === 'function') return

	const locationApi = host.location
	let currentState: unknown = null

	const readUrl = () => locationApi?.href ?? ''

	const currentEntry = (): NavigationHistoryEntryLike =>
		createHistoryEntry(readUrl(), currentState)

	const navigate = (
		url: string | URL,
		options?: { history?: 'auto' | 'push' | 'replace'; state?: unknown },
	): NavigationResultLike => {
		currentState = options?.state ?? null
		const href = typeof url === 'string' ? url : url.toString()
		if (options?.history === 'replace') {
			locationApi?.replace(href)
		} else {
			locationApi?.assign(href)
		}
		return createSettledResult(createHistoryEntry(href, currentState))
	}

	const stub = {
		get currentEntry() {
			return currentEntry()
		},
		addEventListener() {},
		removeEventListener() {},
		updateCurrentEntry(options?: { state?: unknown }) {
			if (options && 'state' in options) {
				currentState = options.state
			}
		},
		entries() {
			return [currentEntry()]
		},
		navigate,
	}

	try {
		Object.defineProperty(host, 'navigation', {
			configurable: true,
			enumerable: true,
			writable: true,
			value: stub,
		})
	} catch {
		try {
			host.navigation = stub
		} catch {
			// Leave the host unchanged; Remix will still throw if it calls navigation.
		}
	}
}
