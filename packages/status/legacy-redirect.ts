/**
 * Dual-served status hostname handling. The canonical public place for status
 * is status.kody.codes. status.heykody.dev is also a worker custom domain:
 * `/health` is sticky so deploy healthchecks can probe that host when the
 * canonical hostname returns Cloudflare 1016; other GET/HEAD requests 308 to
 * the canonical origin.
 */

export const canonicalStatusHost = 'status.kody.codes'
export const canonicalStatusOrigin = `https://${canonicalStatusHost}`
export const legacyStatusHost = 'status.heykody.dev'

const stickyPathPrefixes = ['/health'] as const

function isStickyPath(pathname: string) {
	return stickyPathPrefixes.some(
		(prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
	)
}

/**
 * Redirect safe GET/HEAD navigation from the dual-served status host to
 * status.kody.codes. `/health` is sticky so deploy healthchecks can probe
 * the worker on .dev when the canonical hostname returns Cloudflare 1016.
 *
 * Returns `null` when the request should be served normally.
 */
export function getLegacyStatusRedirectResponse(
	request: Request,
): Response | null {
	const method = request.method
	if (method !== 'GET' && method !== 'HEAD') return null

	let url: URL
	try {
		url = new URL(request.url)
	} catch {
		return null
	}
	if (url.hostname.toLowerCase() !== legacyStatusHost) return null
	if (isStickyPath(url.pathname)) return null

	return Response.redirect(
		`${canonicalStatusOrigin}${url.pathname}${url.search}`,
		308,
	)
}
