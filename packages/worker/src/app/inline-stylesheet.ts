/**
 * Fetches the app stylesheet from the assets bundle so SSR can inline it into
 * a `<style>` tag. The stylesheet is render-blocking as a `<link>`; inlining
 * removes a full round trip from first paint on slow connections.
 *
 * The remix/component stream renderer HTML-escapes text children, which would
 * corrupt CSS containing `&`, `<`, or `>` (e.g. child combinators). Escaping
 * is the identity function for CSS without those characters, so inlining is
 * only offered when the text is escape-safe; callers fall back to the
 * stylesheet `<link>` otherwise.
 *
 * Comments are stripped and whitespace is collapsed before the safety check
 * and before inlining so the homepage HTML budget does not pay for authoring
 * whitespace. `>`, `<`, and `&` anywhere in that prepared text prevent
 * inlining (selectors, declarations, strings, and URLs). Use a descendant
 * combinator instead of `>`.
 */

const STYLESHEET_ASSET_URL = 'https://assets.local/styles.css'

type AssetsFetcher = { fetch: (request: Request) => Promise<Response> }

let stylesheetCache: { buildId: string; css: string | null } | null = null

function stripCssComments(css: string) {
	return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * Collapse authoring whitespace without touching string / url() contents.
 * Keeps spaces that change tokens: media-query `and (` / `or (` / `not (`,
 * descendant combinators before `:` (e.g. `[x] :focus-visible`), and calc()
 * `+` / `-` beside parentheses or values.
 */
function minifyCss(css: string) {
	let out = ''
	let i = 0
	while (i < css.length) {
		const ch = css[i]!
		if (ch === '"' || ch === "'") {
			const quote = ch
			out += ch
			i += 1
			while (i < css.length) {
				const next = css[i]!
				out += next
				i += 1
				if (next === '\\' && i < css.length) {
					out += css[i]!
					i += 1
					continue
				}
				if (next === quote) break
			}
			continue
		}
		if (ch === '(' && out.endsWith('url')) {
			out += ch
			i += 1
			while (i < css.length && /[ \t\n\r\f]/.test(css[i]!)) {
				out += css[i]!
				i += 1
			}
			// Quoted url("…") / url('…') — let the string branch keep `)` inside.
			if (i < css.length && (css[i] === '"' || css[i] === "'")) continue
			while (i < css.length) {
				const next = css[i]!
				out += next
				i += 1
				if (next === ')') break
			}
			continue
		}
		// CSS whitespace only (not JS `\s`, which would fold NBSP in identifiers).
		if (/[ \t\n\r\f]/.test(ch)) {
			let ws = 0
			while (i < css.length && /[ \t\n\r\f]/.test(css[i]!)) {
				i += 1
				ws += 1
			}
			const prev = out.at(-1)
			const next = css[i]
			// Drop space around `{ } : ; ,` only. Do not treat `()` or a leading
			// `:` as glue — that would turn `and (` into the function `and(` and
			// `[host] :focus-visible` into `[host]:focus-visible`.
			if (prev && next && !/[{}:;,]/.test(prev) && !/[{};,]/.test(next)) {
				// A hex escape consumes its first following whitespace. Keep a
				// second space when the author had 2+ so `.\\31  .child` stays a
				// descendant selector instead of collapsing to `.\\31 .child`.
				out += /\\[0-9a-fA-F]{1,6}$/.test(out) && ws >= 2 ? '  ' : ' '
			}
			continue
		}
		out += ch
		i += 1
	}
	return out.trim()
}

function prepareInlineCss(css: string) {
	return minifyCss(stripCssComments(css))
}

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
			const text = prepareInlineCss(await response.text())
			css = text && isEscapeSafeCss(text) ? text : null
		}
	} catch {
		// Missing stylesheet asset just means the <link> fallback is used.
	}
	if (buildId !== 'dev' && css !== null) {
		stylesheetCache = { buildId, css }
	}
	return css
}
