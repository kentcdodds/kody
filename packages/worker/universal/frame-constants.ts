/** Request header the client sends when reloading a named `<Frame>`. */
export const REMIX_FRAME_TARGET_HEADER = 'x-remix-target'

/**
 * Query param added only to frame fetches. Anonymous HTML is cached by URL
 * (browser cache, the Worker Cache API, and Cloudflare), not by
 * `x-remix-target`. A frame reload of the page URL would otherwise receive the
 * cached document and nest another copy of the shell inside the frame.
 */
export const frameFetchSearchParam = '__frame'

export function frameFetchUrl(src: string, target: string | undefined) {
	if (!target) return src
	const isAbsolute = /^[a-z][a-z\d+.-]*:/i.test(src)
	const url = new URL(src, 'https://kody.local')
	url.searchParams.set(frameFetchSearchParam, target)
	if (isAbsolute) return url.href
	return `${url.pathname}${url.search}${url.hash}`
}

/** Header wins; the query param is the cache-key twin for the same target. */
export function requestFrameTarget(request: Request) {
	const header = request.headers.get(REMIX_FRAME_TARGET_HEADER)?.trim()
	if (header) return header
	try {
		const param = new URL(request.url).searchParams
			.get(frameFetchSearchParam)
			?.trim()
		return param ? param : null
	} catch {
		return null
	}
}

/**
 * True when this request must not be answered from the anonymous document
 * cache, even if the pathname is cacheable.
 */
export function requestBypassesAnonymousDocumentCache(request: Request) {
	if (request.headers.has(REMIX_FRAME_TARGET_HEADER)) return true
	try {
		return new URL(request.url).searchParams.has(frameFetchSearchParam)
	} catch {
		return false
	}
}

/** A frame body is a fragment. A cached document starts with doctype or `<html>`. */
export function isFullHtmlDocumentPrefix(html: string) {
	const start = html.trimStart().slice(0, 15).toLowerCase()
	return start.startsWith('<!doctype') || start.startsWith('<html')
}
