/**
 * Serialize a JSON API response. Accepts either a bare status code or a full
 * ResponseInit; Content-Type and Cache-Control get sensible defaults that
 * individual headers can override.
 */
export function jsonResponse(body: unknown, init: number | ResponseInit = 200) {
	const responseInit = typeof init === 'number' ? { status: init } : init
	const headers = new Headers(responseInit.headers)
	if (!headers.has('Content-Type')) {
		headers.set('Content-Type', 'application/json; charset=utf-8')
	}
	if (!headers.has('Cache-Control')) {
		headers.set('Cache-Control', 'no-store')
	}
	return new Response(JSON.stringify(body), { ...responseInit, headers })
}
