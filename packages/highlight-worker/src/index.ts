import {
	type HighlightedCode,
	type HighlightSnippet,
} from '../../worker/universal/highlighted-code.ts'
import { highlightCacheName, highlightCacheRequest } from './cache.ts'
import { handleHighlightHealthRequest } from './health.ts'
import { tokenizeSnippets } from './tokenize.ts'

type HighlightWorkerEnv = {
	APP_COMMIT_SHA?: string
}

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

async function highlightTokenCache() {
	return caches.open(highlightCacheName)
}

async function readCachedResults(
	snippets: Array<HighlightSnippet>,
): Promise<Array<HighlightedCode> | null> {
	try {
		const cache = await highlightTokenCache()
		const cached = await cache.match(highlightCacheRequest(snippets))
		if (!cached?.ok) return null
		const body = (await cached.json()) as { results?: unknown }
		if (!Array.isArray(body.results)) return null
		return body.results as Array<HighlightedCode>
	} catch {
		return null
	}
}

async function writeCachedResults(
	snippets: Array<HighlightSnippet>,
	results: Array<HighlightedCode>,
) {
	try {
		const cache = await highlightTokenCache()
		await cache.put(
			highlightCacheRequest(snippets),
			new Response(JSON.stringify({ results }), {
				headers: {
					'content-type': 'application/json',
					'cache-control': 'public, max-age=86400',
				},
			}),
		)
	} catch (error) {
		console.debug('highlight-worker-cache-write-failed', error)
	}
}

const handler = {
	async fetch(request: Request, env: HighlightWorkerEnv) {
		const health = handleHighlightHealthRequest(request, env)
		if (health) return health

		const url = new URL(request.url)
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

		const cached = await readCachedResults(snippets)
		if (cached) return Response.json({ results: cached })

		const results = tokenizeSnippets(snippets)
		await writeCachedResults(snippets, results)
		return Response.json({ results })
	},
} satisfies ExportedHandler<HighlightWorkerEnv>

export default handler
