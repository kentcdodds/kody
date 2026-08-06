/**
 * Content negotiation for pages that also exist as raw markdown documents
 * (`/guides/:slug`, `/blog/:slug`). Agents and tools can either request the
 * explicit `.md` route or send `Accept: text/markdown` to the HTML route.
 */

/**
 * True when the request's Accept header prefers `text/markdown` over
 * `text/html`. HTML wins ties (including wildcard and absent headers) so
 * browsers keep getting the rendered page.
 */
export function prefersMarkdown(request: Request): boolean {
	const accept = request.headers.get('accept')
	if (!accept) return false

	let markdownQuality = 0
	let htmlQuality = 0
	for (const entry of accept.split(',')) {
		const [rawType, ...params] = entry.trim().split(';')
		const type = rawType?.trim().toLowerCase()
		if (!type) continue
		let quality = 1
		for (const param of params) {
			const [key, value] = param.split('=').map((part) => part.trim())
			if (key === 'q' && value) {
				const parsed = Number(value)
				if (Number.isFinite(parsed)) quality = parsed
			}
		}
		if (type === 'text/markdown') {
			markdownQuality = Math.max(markdownQuality, quality)
		}
		if (type === 'text/html' || type === 'text/*' || type === '*/*') {
			htmlQuality = Math.max(htmlQuality, quality)
		}
	}
	return markdownQuality > htmlQuality
}

export function markdownResponse(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: {
			'Content-Type': 'text/markdown; charset=utf-8',
			// The same URL serves HTML or markdown depending on Accept.
			Vary: 'Accept',
		},
	})
}

/**
 * Marks a negotiated route's HTML variant as Accept-dependent so shared
 * caches never serve HTML to a markdown-first client (or vice versa).
 * Preserves any existing Vary values.
 */
export function withVaryAccept(response: Response): Response {
	const existing = response.headers.get('vary')
	const values = new Set(
		(existing ?? '')
			.split(',')
			.map((value) => value.trim().toLowerCase())
			.filter(Boolean),
	)
	if (values.has('accept') || values.has('*')) return response
	response.headers.append('Vary', 'Accept')
	return response
}
