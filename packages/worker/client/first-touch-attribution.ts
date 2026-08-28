/**
 * Client helper: capture first-touch UTMs from the current URL (and optional
 * document referrer) into sessionStorage so SPA navigations to /signup keep
 * them, then read them back for signup POST / OAuth start.
 */

import {
	emptyFirstTouchAttribution,
	hasFirstTouchAttribution,
	parseFirstTouchAttribution,
	type FirstTouchAttribution,
} from '#universal/first-touch-attribution.ts'

const storageKey = 'kody.firstTouchAttribution'

export function captureFirstTouchAttributionFromLocation(
	href: string = typeof window !== 'undefined' ? window.location.href : '',
	referrer: string | null = typeof document !== 'undefined'
		? document.referrer || null
		: null,
): FirstTouchAttribution {
	let url: URL
	try {
		url = new URL(href, 'https://kody.codes')
	} catch {
		return emptyFirstTouchAttribution
	}

	const fromUrl = parseFirstTouchAttribution({
		searchParams: url.searchParams,
		landingPath: url.pathname,
		referrer,
	})

	if (!hasFirstTouchAttribution(fromUrl)) {
		return readStoredFirstTouchAttribution() ?? emptyFirstTouchAttribution
	}

	// Prefer existing stored first-touch over later UTMs on the same browser.
	const existing = readStoredFirstTouchAttribution()
	if (existing && hasFirstTouchAttribution(existing)) {
		return existing
	}

	writeStoredFirstTouchAttribution(fromUrl)
	return fromUrl
}

export function readSignupFirstTouchAttribution(): FirstTouchAttribution {
	const captured = captureFirstTouchAttributionFromLocation()
	if (hasFirstTouchAttribution(captured)) return captured
	return emptyFirstTouchAttribution
}

function writeStoredFirstTouchAttribution(value: FirstTouchAttribution) {
	if (typeof sessionStorage === 'undefined') return
	try {
		sessionStorage.setItem(storageKey, JSON.stringify(value))
	} catch {
		// Private mode / quota — signup can still send URL params directly.
	}
}

function readStoredFirstTouchAttribution(): FirstTouchAttribution | null {
	if (typeof sessionStorage === 'undefined') return null
	try {
		const raw = sessionStorage.getItem(storageKey)
		if (!raw) return null
		const parsed = JSON.parse(raw) as unknown
		const attribution = parseFirstTouchAttribution({ body: parsed })
		return hasFirstTouchAttribution(attribution) ? attribution : null
	} catch {
		return null
	}
}

export function clearStoredFirstTouchAttribution() {
	if (typeof sessionStorage === 'undefined') return
	try {
		sessionStorage.removeItem(storageKey)
	} catch {
		// ignore
	}
}
