import {
	plainHighlightedCode,
	type HighlightSnippet,
} from '../packages/worker/universal/highlighted-code.ts'

/**
 * Auxiliary worker for the workers-unit vitest pool: the main worker's test
 * env binds HIGHLIGHT to "kody-highlight-test", which local `wrangler dev`
 * resolves from the real highlight-worker config. The vitest pool only loads
 * the main worker config, so this bundle serves the highlight fetch contract
 * with plaintext tokens (Shiki stays on the real highlight worker).
 */

function isSnippet(value: unknown): value is HighlightSnippet {
	if (typeof value !== 'object' || value === null) return false
	const snippet = value as { code?: unknown; lang?: unknown }
	if (typeof snippet.code !== 'string') return false
	return (
		snippet.lang === undefined ||
		snippet.lang === null ||
		typeof snippet.lang === 'string'
	)
}

function parseSnippets(value: unknown): Array<HighlightSnippet> | null {
	if (typeof value !== 'object' || value === null) return null
	const body = value as { snippets?: unknown }
	if (!Array.isArray(body.snippets)) return null
	if (!body.snippets.every(isSnippet)) return null
	return body.snippets
}

export default {
	async fetch(request: Request) {
		const url = new URL(request.url)
		if (request.method === 'GET' && url.pathname === '/health') {
			return Response.json({ ok: true, commit: 'test' })
		}
		if (request.method !== 'POST' || url.pathname !== '/highlight') {
			return new Response('Not found', { status: 404 })
		}

		let parsed: unknown
		try {
			parsed = await request.json()
		} catch {
			return Response.json({ error: 'Invalid JSON.' }, { status: 400 })
		}
		const snippets = parseSnippets(parsed)
		if (!snippets) {
			return Response.json({ error: 'Expected { snippets }.' }, { status: 400 })
		}

		return Response.json({
			results: snippets.map((snippet) =>
				plainHighlightedCode(snippet.code, snippet.lang),
			),
		})
	},
}
