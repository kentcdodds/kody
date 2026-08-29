/**
 * Browser `fetch()` network failures that reject as TypeError. Exact strings
 * only — Firefox (KODY-CLOUDFLARE-3P), Chromium, and WebKit — so unrelated
 * TypeErrors still surface their own message.
 *
 * Chromium Mobile sometimes appends the failed origin as a parenthetical
 * (`Failed to fetch (kody.codes)`, KODY-6A) — that is still the same network
 * blip, not "Failed to fetch dynamically imported module: …".
 */

const browserFetchNetworkErrorMessages = new Set([
	'NetworkError when attempting to fetch resource.',
	'Failed to fetch',
	'Load failed',
])

/** Chromium "Failed to fetch (hostname)" without matching dynamic-import text. */
const chromiumFailedToFetchWithOrigin = /^Failed to fetch(?:\s+\([^)]+\))?$/i

export function normalizeBrowserFetchNetworkErrorMessage(message: string) {
	const withoutTypePrefix = message.trim().replace(/^TypeError:\s*/i, '')
	if (chromiumFailedToFetchWithOrigin.test(withoutTypePrefix)) {
		return 'Failed to fetch'
	}
	return withoutTypePrefix
}

export function isBrowserFetchNetworkErrorMessage(message: string) {
	return browserFetchNetworkErrorMessages.has(
		normalizeBrowserFetchNetworkErrorMessage(message),
	)
}

export function isBrowserFetchNetworkError(error: unknown): boolean {
	if (!(error instanceof TypeError)) return false
	return isBrowserFetchNetworkErrorMessage(error.message)
}

/**
 * True when a thrown Error's stack names Remix `resolveFrame`, the
 * `fetchFrameResolve` helper that owns the `fetch`, or `createFrameResolveInit`
 * (bundler/source-map often attributes the fetch to that init helper —
 * KODY-CLOUDFLARE-5Y / KODY-6A). Mobile Safari often keeps only the immediate
 * caller on `Error.stack`.
 */
export function errorStackMentionsResolveFrame(error: unknown) {
	if (typeof error !== 'object' || error === null) return false
	if (!('stack' in error) || typeof error.stack !== 'string') return false
	return /\b(?:resolveFrame|fetchFrameResolve|createFrameResolveInit)\b/.test(
		error.stack,
	)
}
