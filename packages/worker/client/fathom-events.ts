/**
 * Public-site Fathom custom events only (not factory/MCP/execute).
 * Fathom is loaded via SSR with data-spa="auto"; these call trackEvent when
 * the global is present. Never send emails, secrets, or package contents.
 */

import {
	accountCreatedQueryParam,
	fathomEventNames,
	type FathomEventName,
} from '#universal/fathom-events.ts'

export { fathomEventNames, type FathomEventName }

type FathomTracker = {
	trackEvent: (name: string) => void
}

function readFathom(): FathomTracker | null {
	if (typeof window === 'undefined') return null
	const candidate = (window as Window & { fathom?: FathomTracker }).fathom
	if (!candidate || typeof candidate.trackEvent !== 'function') return null
	return candidate
}

/**
 * Fire a named Fathom event. No-ops when Fathom is not loaded (local/dev
 * without FATHOM_SITE_ID, or before the script runs).
 */
export function trackFathomEvent(name: FathomEventName | string): void {
	try {
		readFathom()?.trackEvent(name)
	} catch {
		// Analytics must never break auth or navigation.
	}
}

/**
 * If the current URL carries accountCreated=1, fire account_created once and
 * strip the query param from the address bar without a navigation.
 */
export function consumeAccountCreatedFathomSignal(): boolean {
	if (typeof window === 'undefined') return false
	try {
		const url = new URL(window.location.href)
		if (url.searchParams.get(accountCreatedQueryParam) !== '1') return false
		trackFathomEvent(fathomEventNames.accountCreated)
		url.searchParams.delete(accountCreatedQueryParam)
		const next = `${url.pathname}${url.search}${url.hash}`
		window.history.replaceState(window.history.state, '', next)
		return true
	} catch {
		return false
	}
}
