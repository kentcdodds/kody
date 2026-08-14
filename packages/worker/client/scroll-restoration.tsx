import { addEventListeners, type Handle } from 'remix/ui'
import {
	parseSavedScrollPositions,
	scrollRestorationStorageKey,
	serializeSavedScrollPositions,
} from '#universal/router-scroll-restoration.ts'
import { routerEvents } from './client-router.tsx'
import {
	ensureCurrentScrollRestorationKey,
	getCurrentScrollRestorationKey,
	getScrollRestorationTarget,
	nextSavedScrollPosition,
	type RouterNavigationEventDetail,
	type ScrollHistoryAction,
	type ScrollPosition,
	type ScrollRestorationTarget,
} from './router-scroll-state.ts'

const savedScrollPositions = new Map<string, ScrollPosition>()
let positionsLoaded = false
let restoreScrollRequestId = 0
let restoreInProgress = false

function loadSavedScrollPositions() {
	if (positionsLoaded || typeof sessionStorage === 'undefined') return
	positionsLoaded = true
	try {
		const positions = parseSavedScrollPositions(
			sessionStorage.getItem(scrollRestorationStorageKey),
		)
		for (const [key, y] of Object.entries(positions)) {
			savedScrollPositions.set(key, { x: 0, y })
		}
	} catch {
		// Session storage may be unavailable in private modes; scroll still works
		// for the current in-memory session.
	}
}

function persistSavedScrollPositions() {
	if (typeof sessionStorage === 'undefined') return
	try {
		const positions: Record<string, number> = {}
		for (const [key, position] of savedScrollPositions) {
			positions[key] = position.y
		}
		sessionStorage.setItem(
			scrollRestorationStorageKey,
			serializeSavedScrollPositions(positions),
		)
	} catch {
		// Ignore quota and privacy-mode storage failures.
	}
}

function saveWindowScrollPosition() {
	const key = ensureCurrentScrollRestorationKey()
	if (!key) return
	const current = {
		x: window.scrollX,
		y: window.scrollY,
	}
	savedScrollPositions.set(
		key,
		nextSavedScrollPosition(
			savedScrollPositions.get(key),
			current,
			maxWindowScrollPosition(),
		),
	)
}

function persistWindowScrollPosition() {
	if (!restoreInProgress) {
		saveWindowScrollPosition()
	}
	persistSavedScrollPositions()
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

type ScrollRestoreRequest = {
	location: string
	historyAction: ScrollHistoryAction
	preventScrollReset: boolean
}

function applyWindowScroll(
	detail: ScrollRestoreRequest,
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
	detail: ScrollRestoreRequest,
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
	restoreInProgress = true
	const startedAt = Date.now()
	// Document-load restore keeps applying the saved Y after it is reachable so
	// late layout (images, fonts, scroll anchoring) cannot persist a drifted
	// position before the page settles.
	const pinUntilDeadline =
		target.type === 'position' && detail.historyAction === 'load'
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
	const finish = () => {
		if (requestId === restoreScrollRequestId) {
			restoreInProgress = false
		}
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
			finish()
			return
		}
		const isFinalAttempt = Date.now() - startedAt >= scrollRestorationDeadlineMs
		const reached = applyWindowScroll(detail, target, isFinalAttempt)
		if (isFinalAttempt || (reached && !pinUntilDeadline)) {
			finish()
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
		restoreWindowScroll(
			{
				location: `${window.location.pathname}${window.location.search}${window.location.hash}`,
				historyAction: 'load',
				preventScrollReset: false,
			},
			handle.signal,
		)
		addEventListeners(window, handle.signal, {
			scroll: persistWindowScrollPosition,
			pagehide: persistWindowScrollPosition,
			beforeunload: persistWindowScrollPosition,
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
