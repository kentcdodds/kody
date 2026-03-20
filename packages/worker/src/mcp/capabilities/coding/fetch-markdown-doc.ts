/**
 * Prefer markdown (or plain text) over HTML so agent context stays small where
 * the origin supports content negotiation (e.g. GitHub Docs → text/markdown).
 * Cursor’s docs often respond as text/plain with markdown-shaped bodies.
 */
export const MARKDOWN_PREFERRED_ACCEPT =
	'text/markdown, text/plain;q=0.9, text/html;q=0.8'

const MAX_DOC_CHARS = 2_000_000

export async function fetchMarkdownPreferredDoc(url: string): Promise<{
	status: number
	contentType: string | null
	body: string
	markdownTokenEstimate: string | null
}> {
	const response = await fetch(url, {
		headers: { Accept: MARKDOWN_PREFERRED_ACCEPT },
		redirect: 'follow',
	})
	const body = await response.text()
	if (body.length > MAX_DOC_CHARS) {
		throw new Error(
			`documentation response exceeds ${MAX_DOC_CHARS} characters`,
		)
	}
	return {
		status: response.status,
		contentType: response.headers.get('content-type'),
		body,
		markdownTokenEstimate: response.headers.get('x-markdown-tokens'),
	}
}
