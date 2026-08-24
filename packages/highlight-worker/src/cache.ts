import {
	highlightSnippetKey,
	type HighlightSnippet,
} from '../../worker/universal/highlighted-code.ts'

export const highlightCacheName = 'kody-highlight-tokens'

const cacheOrigin = 'https://highlight-cache.local'

export function highlightCacheRequest(snippets: Array<HighlightSnippet>) {
	const key = snippets.map((snippet) => highlightSnippetKey(snippet)).join('\n')
	return new Request(`${cacheOrigin}/batch`, {
		method: 'POST',
		headers: { 'content-type': 'text/plain' },
		body: key,
	})
}
