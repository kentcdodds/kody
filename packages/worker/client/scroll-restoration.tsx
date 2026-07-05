import { addEventListeners, type Handle } from 'remix/ui'
import { routerEvents } from './client-router.tsx'
import {
	ensureCurrentScrollRestorationKey,
	getCurrentScrollRestorationKey,
	getScrollRestorationTarget,
	type RouterNavigationEventDetail,
	type ScrollPosition,
} from './router-scroll-state.ts'

const scrollPositionsSessionKey = 'kody:router-scroll-positions'
const savedScrollPositions = new Map<string, ScrollPosition>()
let positionsLoaded = false
let restoreScrollRequestId = 0

function isScrollPosition(value: unknown): value is ScrollPosition {
	return (
		typeof value === 'object' &&
		value !== null &&
		'x' in value &&
		'y' in value &&
		typeof value.x === 'number' &&
		typeof value.y === 'number'
	)
}

function loadSavedScrollPositions() {
	if (positionsLoaded || typeof sessionStorage === 'undefined') return
	positionsLoaded = true
	try {
		const rawPositions = sessionStorage.getItem(scrollPositionsSessionKey)
		if (!rawPositions) return
		const entries = JSON.parse(rawPositions) as unknown
		if (!Array.isArray(entries)) return
		for (const entry of entries) {
			if (!Array.isArray(entry) || entry.length !== 2) continue
			const [key, position] = entry
			if (typeof key === 'string' && isScrollPosition(position)) {
				savedScrollPositions.set(key, position)
			}
		}
	} catch {
		// Session storage may be unavailable in private modes; scroll still works
		// for the current in-memory session.
	}
}

function persistSavedScrollPositions() {
	if (typeof sessionStorage === 'undefined') return
	try {
		sessionStorage.setItem(
			scrollPositionsSessionKey,
			JSON.stringify(Array.from(savedScrollPositions.entries())),
		)
	} catch {
		// Ignore quota and privacy-mode storage failures.
	}
}

function saveWindowScrollPosition() {
	const key = ensureCurrentScrollRestorationKey()
	if (!key) return
	savedScrollPositions.set(key, {
		x: window.scrollX,
		y: window.scrollY,
	})
}

function getHashTarget(id: string) {
	return document.getElementById(id)
}

function isRouterNavigationEvent(
	event: Event,
): event is CustomEvent<RouterNavigationEventDetail> {
	const detail = (event as CustomEvent<RouterNavigationEventDetail>).detail
	return (
		typeof detail === 'object' &&
		detail !== null &&
		typeof detail.location === 'string' &&
		typeof detail.historyAction === 'string'
	)
}

function scheduleScrollRestoration(
	applyScroll: () => void,
	signal: AbortSignal,
) {
	const requestId = ++restoreScrollRequestId
	const run = () => {
		if (signal.aborted || requestId !== restoreScrollRequestId) return
		applyScroll()
	}
	if (typeof window.requestAnimationFrame === 'function') {
		window.requestAnimationFrame(run)
		return
	}
	window.setTimeout(run, 0)
}

function applyWindowScroll(detail: RouterNavigationEventDetail) {
	const key = getCurrentScrollRestorationKey()
	const target = getScrollRestorationTarget({
		historyAction: detail.historyAction,
		location: detail.location,
		preventScrollReset: detail.preventScrollReset,
		savedPosition: key ? savedScrollPositions.get(key) : null,
	})

	switch (target.type) {
		case 'position':
			window.scrollTo(target.position.x, target.position.y)
			return
		case 'hash': {
			const element = getHashTarget(target.id)
			if (element) {
				element.scrollIntoView()
				return
			}
			if (detail.preventScrollReset) return
			window.scrollTo(0, 0)
			return
		}
		case 'preserve':
			return
		case 'top':
			window.scrollTo(0, 0)
			return
		default: {
			const exhaustive: never = target
			return exhaustive
		}
	}
}

function restoreWindowScroll(
	detail: RouterNavigationEventDetail,
	signal: AbortSignal,
) {
	scheduleScrollRestoration(() => applyWindowScroll(detail), signal)
}

function handleNavigationStart(event: Event) {
	if (isRouterNavigationEvent(event) && event.detail.historyAction === 'pop') {
		return
	}
	saveWindowScrollPosition()
}

export function ScrollRestoration(handle: Handle) {
	if (typeof document !== 'undefined') {
		loadSavedScrollPositions()
		ensureCurrentScrollRestorationKey()
		const previousScrollRestoration =
			'scrollRestoration' in window.history
				? window.history.scrollRestoration
				: null
		if (previousScrollRestoration !== null) {
			window.history.scrollRestoration = 'manual'
		}

		addEventListeners(routerEvents, handle.signal, {
			navigationstart: handleNavigationStart,
			navigationend(event: Event) {
				if (!isRouterNavigationEvent(event)) return
				restoreWindowScroll(event.detail, handle.signal)
			},
		})
		addEventListeners(window, handle.signal, {
			scroll: saveWindowScrollPosition,
			pagehide() {
				saveWindowScrollPosition()
				persistSavedScrollPositions()
			},
		})
		handle.signal.addEventListener('abort', () => {
			persistSavedScrollPositions()
			if (previousScrollRestoration !== null) {
				window.history.scrollRestoration = previousScrollRestoration
			}
		})
	}

	return () => null
}
