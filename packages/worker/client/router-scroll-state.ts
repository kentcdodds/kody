import { isRecord } from '@kody-internal/shared/is-record.ts'

export type RouterHistoryAction = 'push' | 'pop' | 'replace'

export type RouterNavigateOptions = {
	preventScrollReset?: boolean
}

export type RouterNavigationEventDetail = {
	location: string
	historyAction: RouterHistoryAction
	preventScrollReset: boolean
}

export type ScrollPosition = {
	x: number
	y: number
}

export type ScrollRestorationTarget =
	| { type: 'hash'; id: string }
	| { type: 'position'; position: ScrollPosition }
	| { type: 'preserve' }
	| { type: 'top' }

const historyStateScrollKey = 'kodyScrollRestorationKey'
let scrollRestorationKeyCount = 0

export function createScrollRestorationKey() {
	scrollRestorationKeyCount += 1
	return `${Date.now().toString(36)}-${scrollRestorationKeyCount.toString(36)}`
}

export function getScrollRestorationKey(state: unknown) {
	if (!isRecord(state)) return null
	const key = state[historyStateScrollKey]
	return typeof key === 'string' ? key : null
}

export function createScrollRestorationHistoryState(
	state: unknown,
	key = createScrollRestorationKey(),
) {
	return {
		...(isRecord(state) ? state : {}),
		[historyStateScrollKey]: key,
	}
}

export function getCurrentScrollRestorationKey() {
	if (typeof window === 'undefined') return null
	return getScrollRestorationKey(window.history.state)
}

export function ensureCurrentScrollRestorationKey() {
	if (typeof window === 'undefined') return null
	const existing = getCurrentScrollRestorationKey()
	if (existing) return existing
	const key = createScrollRestorationKey()
	window.history.replaceState(
		createScrollRestorationHistoryState(window.history.state, key),
		'',
		window.location.href,
	)
	return key
}

export function getScrollRestorationHash(location: string) {
	const hash = new URL(location, 'https://kody.local').hash
	if (!hash) return null
	const encodedId = hash.slice(1)
	try {
		return decodeURIComponent(encodedId)
	} catch {
		return encodedId
	}
}

export function getScrollRestorationTarget(input: {
	historyAction: RouterHistoryAction
	location: string
	preventScrollReset?: boolean
	savedPosition?: ScrollPosition | null
}): ScrollRestorationTarget {
	if (input.historyAction === 'pop' && input.savedPosition) {
		return { type: 'position', position: input.savedPosition }
	}

	const hash = getScrollRestorationHash(input.location)
	if (hash) return { type: 'hash', id: hash }

	if (input.preventScrollReset) return { type: 'preserve' }
	return { type: 'top' }
}
