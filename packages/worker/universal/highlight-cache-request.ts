import {
	highlightSnippetKey,
	type HighlightSnippet,
} from './highlighted-code.ts'

/**
 * Cloudflare Cache API keys are GET/HEAD URLs. The request body is not part
 * of the key, so snippet identity is hashed into the pathname.
 */
export async function highlightBatchCacheRequest(
	cacheOrigin: string,
	snippets: Array<HighlightSnippet>,
) {
	const material = snippets
		.map((snippet) => highlightSnippetKey(snippet))
		.join('\n')
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(material),
	)
	const hash = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('')
	return new Request(new URL(`/batch/${hash}`, cacheOrigin))
}
