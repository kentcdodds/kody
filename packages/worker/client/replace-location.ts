import { routerEvents } from '#client/client-router.tsx'

/**
 * Replace the current URL without adding a history entry and notify the
 * router so route components re-render against the new location. Use this
 * for URL-backed filter state (search fields, filter selects) where every
 * keystroke would otherwise pollute history or restart scroll positions.
 */
export function replaceLocation(to: string) {
	if (typeof window === 'undefined') return
	const destination = new URL(to, window.location.href)
	const nextPath = `${destination.pathname}${destination.search}${destination.hash}`
	const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`
	if (nextPath === currentPath) return
	window.history.replaceState({}, '', nextPath)
	routerEvents.dispatchEvent(new Event('navigate'))
}
