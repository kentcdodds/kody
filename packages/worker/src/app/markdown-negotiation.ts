/**
 * Content negotiation for pages that also exist as raw markdown documents
 * (`/guides/:slug`, `/blog/:slug`). Agents and tools can either request the
 * explicit `.md` route or send `Accept: text/markdown` to the HTML route.
 */

/** Quality per media-range specificity tier; exact beats text/* beats * / *. */
type RangeQualities = {
	exact: number | null
	textWildcard: number | null
	globalWildcard: number | null
}

function effectiveQuality(ranges: RangeQualities): number {
	return ranges.exact ?? ranges.textWildcard ?? ranges.globalWildcard ?? 0
}

/**
 * True when the request's Accept header prefers `text/markdown` over
 * `text/html`. Wildcard ranges (`text/*` and the global wildcard) match both
 * representations and an exact type overrides a wildcard, so
 * `text/html;q=0, text/*;q=0.8` serves markdown. HTML wins ties (including
 * bare wildcards and absent headers) so browsers keep getting the rendered
 * page.
 */
export function prefersMarkdown(request: Request): boolean {
	const accept = request.headers.get('accept')
	if (!accept) return false

	const markdown: RangeQualities = {
		exact: null,
		textWildcard: null,
		globalWildcard: null,
	}
	const html: RangeQualities = {
		exact: null,
		textWildcard: null,
		globalWildcard: null,
	}

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
		const tier: keyof RangeQualities | null =
			type === '*/*'
				? 'globalWildcard'
				: type === 'text/*'
					? 'textWildcard'
					: type === 'text/markdown' || type === 'text/html'
						? 'exact'
						: null
		if (!tier) continue
		if (tier === 'exact') {
			const target = type === 'text/markdown' ? markdown : html
			target.exact = Math.max(target.exact ?? 0, quality)
		} else {
			markdown[tier] = Math.max(markdown[tier] ?? 0, quality)
			html[tier] = Math.max(html[tier] ?? 0, quality)
		}
	}
	return effectiveQuality(markdown) > effectiveQuality(html)
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
