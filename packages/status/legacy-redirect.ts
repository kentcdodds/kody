/**
 * Legacy status hostname handling. The canonical public place for status is
 * status.kody.codes. status.heykody.dev stays attached as a worker custom
 * domain so `/health` still works if the canonical host is 1016 until DNS
 * exists; other GET/HEAD requests 308 to the canonical origin.
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
 * Redirect safe GET/HEAD navigation from the legacy status host to
 * status.kody.codes. `/health` stays sticky so deploy healthchecks can probe
 * the worker on .dev when the canonical hostname is not attached yet.
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
