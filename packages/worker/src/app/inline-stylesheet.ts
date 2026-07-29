/**
 * Fetches the app stylesheet from the assets bundle so SSR can inline it into
 * a `<style>` tag. The stylesheet is ~5KB and render-blocking as a `<link>`;
 * inlining removes a full round trip from first paint on slow connections.
 *
 * The remix/ui stream renderer HTML-escapes text children, which would
 * corrupt CSS containing `&`, `<`, or `>` (e.g. child combinators). Escaping
 * is the identity function for CSS without those characters, so inlining is
 * only offered when the text is escape-safe; callers fall back to the
 * stylesheet `<link>` otherwise.
 */

const STYLESHEET_ASSET_URL = 'https://assets.local/styles.css'

type AssetsFetcher = { fetch: (request: Request) => Promise<Response> }

let stylesheetCache: { buildId: string; css: string | null } | null = null

function isEscapeSafeCss(css: string) {
	return !/[<>&]/.test(css)
}

/** Test hook: clears the per-isolate stylesheet cache. */
export function resetInlineStylesheetCache() {
	stylesheetCache = null
}

/**
 * Stylesheet text to inline, or null when unavailable or not escape-safe
 * (callers must then render the `<link rel="stylesheet">` fallback). Cached
 * per build id outside dev.
 */
export async function getInlineStylesheet(input: {
	assets: AssetsFetcher | undefined
	buildId: string
}): Promise<string | null> {
	const { assets, buildId } = input
	if (!assets) return null
	if (buildId !== 'dev' && stylesheetCache?.buildId === buildId) {
		return stylesheetCache.css
	}
	let css: string | null = null
	try {
		const response = await assets.fetch(new Request(STYLESHEET_ASSET_URL))
		if (response.ok) {
			const text = await response.text()
			css = isEscapeSafeCss(text) ? text : null
		}
	} catch {
		// Missing stylesheet asset just means the <link> fallback is used.
	}
	if (buildId !== 'dev' && css !== null) {
		stylesheetCache = { buildId, css }
	}
	return css
}
