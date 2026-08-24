/**
 * Browser `fetch()` network failures that reject as TypeError. Exact strings
 * only — Firefox (KODY-CLOUDFLARE-3P), Chromium, and WebKit — so unrelated
 * TypeErrors still surface their own message.
 */

const browserFetchNetworkErrorMessages = new Set([
	'NetworkError when attempting to fetch resource.',
	'Failed to fetch',
	'Load failed',
])

export function normalizeBrowserFetchNetworkErrorMessage(message: string) {
	return message.trim().replace(/^TypeError:\s*/i, '')
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

/** True when a thrown Error's stack names Remix `resolveFrame` (KODY-CLOUDFLARE-5Y). */
export function errorStackMentionsResolveFrame(error: unknown) {
	if (typeof error !== 'object' || error === null) return false
	if (!('stack' in error) || typeof error.stack !== 'string') return false
	return /\bresolveFrame\b/.test(error.stack)
}
