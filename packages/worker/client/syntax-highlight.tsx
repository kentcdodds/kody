import { type RemixNode } from 'remix/ui'

/**
 * Public highlighting API. The Shiki grammars live in
 * `syntax-highlight-core.tsx` and are loaded only through this dynamic
 * import so they stay out of the marketing entry's static closure (esbuild
 * otherwise merges them into the shared homepage chunk).
 *
 * Call `loadSyntaxHighlight()` before rendering code-bearing routes (SSR,
 * hydration, and SPA preload already do this for those areas). Until the
 * chunk resolves, fences render as escaped plaintext in the same wrapper
 * so hydration has a safe fallback.
 */
type HighlightModule = {
	renderHighlightedCode: (
		code: string,
		lang?: string | null,
		key?: number,
	) => RemixNode
}

let highlightModule: HighlightModule | null = null
let highlightPending: Promise<HighlightModule> | null = null

export function loadSyntaxHighlight(): Promise<HighlightModule> {
	if (highlightModule) return Promise.resolve(highlightModule)
	if (!highlightPending) {
		// Dynamic import is intentional so Shiki is an async chunk
		// (sanctioned exception to the no-inline-imports rule).
		highlightPending = import('./syntax-highlight-core.tsx')
			.then((module) => {
				highlightModule = module
				return module
			})
			.finally(() => {
				if (!highlightModule) highlightPending = null
			})
	}
	return highlightPending
}

/** Test hook: drops the cached highlighter module. */
export function resetSyntaxHighlightLoadForTests() {
	highlightModule = null
	highlightPending = null
}

/**
 * Highlight `code` as a `<pre class="shiki">` tree once the core chunk is
 * loaded. Unknown languages and oversized snippets fall back to escaped
 * plain text in the same wrapper.
 */
export function renderHighlightedCode(
	code: string,
	lang?: string | null,
	key?: number,
): RemixNode {
	if (highlightModule) {
		return highlightModule.renderHighlightedCode(code, lang, key)
	}
	return (
		<pre key={key} class="shiki shiki-themes github-light github-dark">
			<code>{code}</code>
		</pre>
	)
}
