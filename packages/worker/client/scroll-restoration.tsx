import { addEventListeners, type Handle } from 'remix/ui'
import { routerEvents } from './client-router.tsx'
import {
	ensureCurrentScrollRestorationKey,
	getCurrentScrollRestorationKey,
	getScrollRestorationTarget,
	type RouterNavigationEventDetail,
	type ScrollPosition,
	type ScrollRestorationTarget,
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

// Async route content (frames, deferred lists, images) can keep the document
// too short to reach a saved scroll position right after navigation. Retry on
// animation frames until the position becomes reachable or this deadline
// hits. Generous on purpose: slow fetches must not strand the old scroll
// position, and retries stop early on user scroll or the next navigation.
const scrollRestorationDeadlineMs = 15_000

// Input that signals the user has taken over scrolling; mousedown covers
// scrollbar drags.
const userScrollInputEvents = [
	'wheel',
	'touchmove',
	'keydown',
	'mousedown',
] as const

function maxWindowScrollPosition(): ScrollPosition {
	const root = document.documentElement
	return {
		x: Math.max(0, root.scrollWidth - window.innerWidth),
		y: Math.max(0, root.scrollHeight - window.innerHeight),
	}
}

function applyWindowScroll(
	detail: RouterNavigationEventDetail,
	target: ScrollRestorationTarget,
	isFinalAttempt: boolean,
): boolean {
	switch (target.type) {
		case 'position': {
			window.scrollTo({
				left: target.position.x,
				top: target.position.y,
				behavior: 'instant',
			})
			const max = maxWindowScrollPosition()
			// Report failure while the document is still too short to reach the
			// saved position so the caller retries once more content rendered.
			return target.position.y <= max.y && target.position.x <= max.x
		}
		case 'hash': {
			const element = getHashTarget(target.id)
			if (element) {
				element.scrollIntoView({ behavior: 'instant' })
				return true
			}
			// The hash target may render asynchronously; retry until the deadline
			// before falling back.
			if (!isFinalAttempt) return false
			if (detail.preventScrollReset) return true
			window.scrollTo({ left: 0, top: 0, behavior: 'instant' })
			return true
		}
		case 'preserve':
			return true
		case 'top':
			window.scrollTo({ left: 0, top: 0, behavior: 'instant' })
			return true
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
	const key = getCurrentScrollRestorationKey()
	const target = getScrollRestorationTarget({
		historyAction: detail.historyAction,
		location: detail.location,
		preventScrollReset: detail.preventScrollReset,
		savedPosition: key ? savedScrollPositions.get(key) : null,
	})
	const requestId = ++restoreScrollRequestId
	const startedAt = Date.now()
	// Restoration must never fight manual scrolling, but layout-driven shifts
	// (scroll anchoring, async content replacing nodes above the viewport) can
	// move the position between attempts without any user involvement. Watch
	// for real input instead of comparing positions across attempts.
	let userInteracted = false
	const markUserInteraction = () => {
		userInteracted = true
	}
	for (const eventName of userScrollInputEvents) {
		window.addEventListener(eventName, markUserInteraction, { passive: true })
	}
	const stopListening = () => {
		for (const eventName of userScrollInputEvents) {
			window.removeEventListener(eventName, markUserInteraction)
		}
	}
	const schedule = (run: () => void) => {
		if (typeof window.requestAnimationFrame === 'function') {
			window.requestAnimationFrame(run)
			return
		}
		window.setTimeout(run, 0)
	}
	const attempt = () => {
		if (
			signal.aborted ||
			requestId !== restoreScrollRequestId ||
			userInteracted
		) {
			stopListening()
			return
		}
		const isFinalAttempt = Date.now() - startedAt >= scrollRestorationDeadlineMs
		if (applyWindowScroll(detail, target, isFinalAttempt) || isFinalAttempt) {
			stopListening()
			return
		}
		schedule(attempt)
	}
	attempt()
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
