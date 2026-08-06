import cssLang from '@shikijs/langs/css'
import diffLang from '@shikijs/langs/diff'
import dockerfileLang from '@shikijs/langs/dockerfile'
import dotenvLang from '@shikijs/langs/dotenv'
import goLang from '@shikijs/langs/go'
import graphqlLang from '@shikijs/langs/graphql'
import htmlLang from '@shikijs/langs/html'
import iniLang from '@shikijs/langs/ini'
import jsonLang from '@shikijs/langs/json'
import markdownLang from '@shikijs/langs/markdown'
import pythonLang from '@shikijs/langs/python'
import rustLang from '@shikijs/langs/rust'
import shellscriptLang from '@shikijs/langs/shellscript'
import sqlLang from '@shikijs/langs/sql'
import tomlLang from '@shikijs/langs/toml'
import tsxLang from '@shikijs/langs/tsx'
import typescriptLang from '@shikijs/langs/typescript'
import xmlLang from '@shikijs/langs/xml'
import yamlLang from '@shikijs/langs/yaml'
import githubDark from '@shikijs/themes/github-dark'
import githubLight from '@shikijs/themes/github-light'
import { type RemixNode } from 'remix/ui'
import { createHighlighterCoreSync } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

/**
 * Fine-grained Shiki bundle for first-party pages and markdown code fences.
 *
 * Worker constraints drive the shape:
 * - JavaScript regex engine (no Oniguruma WASM init on Workers)
 * - Sync highlighter so SSR markdown stays synchronous and hydrates
 * - Explicit langs/themes only (the full `shiki` entry would bloat both
 *   worker and client bundles)
 * - Tokens rendered as JSX text + inline styles (never `innerHTML`), so
 *   untrusted README fences stay inside the markdown safety model
 */
const highlighter = createHighlighterCoreSync({
	themes: [githubLight, githubDark],
	langs: [
		typescriptLang,
		tsxLang,
		jsonLang,
		yamlLang,
		tomlLang,
		markdownLang,
		htmlLang,
		cssLang,
		shellscriptLang,
		diffLang,
		pythonLang,
		dockerfileLang,
		dotenvLang,
		iniLang,
		graphqlLang,
		sqlLang,
		xmlLang,
		goLang,
		rustLang,
	],
	engine: createJavaScriptRegexEngine({ forgiving: true }),
})

const loadedLanguages = new Set(highlighter.getLoadedLanguages())

/** Skip highlighting past this size; huge dumps stay readable as plain text. */
const maxHighlightChars = 50_000
const maxLineLength = 2_000

const shikiPreClass = 'shiki shiki-themes github-light github-dark'

function normalizeLang(lang: string | null | undefined): string {
	const trimmed = lang?.trim().toLowerCase() ?? ''
	if (!trimmed) return 'plaintext'
	// marked / authors sometimes pass `ts tsx` or `javascript {1,3}`.
	const primary = trimmed.split(/[\s{,]+/, 1)[0] ?? 'plaintext'
	return primary || 'plaintext'
}

const langAliases: Record<string, string> = {
	js: 'ts',
	javascript: 'ts',
	cjs: 'ts',
	mjs: 'ts',
	jsx: 'tsx',
}

function resolveLang(lang: string | null | undefined): string {
	const normalized = normalizeLang(lang)
	if (
		normalized === 'plaintext' ||
		normalized === 'text' ||
		normalized === 'txt'
	) {
		return 'plaintext'
	}
	const aliased = langAliases[normalized] ?? normalized
	return loadedLanguages.has(aliased) ? aliased : 'plaintext'
}

function rootStyleFromTokens(fg: string | undefined, bg: string | undefined) {
	const style: Record<string, string> = {}
	for (const value of [bg, fg]) {
		if (!value) continue
		const [first, ...rest] = value.split(';')
		if (first && value === bg) style.backgroundColor = first
		if (first && value === fg) style.color = first
		for (const part of rest) {
			const separator = part.indexOf(':')
			if (separator <= 0) continue
			style[part.slice(0, separator)] = part.slice(separator + 1)
		}
	}
	return style
}

function renderPlainCode(code: string, key?: number): RemixNode {
	return (
		<pre key={key} class={shikiPreClass}>
			<code>{code}</code>
		</pre>
	)
}

/**
 * Highlight `code` as a `<pre class="shiki">` tree. Unknown languages and
 * oversized snippets fall back to escaped plain text in the same wrapper.
 */
export function renderHighlightedCode(
	code: string,
	lang?: string | null,
	key?: number,
): RemixNode {
	if (code.length > maxHighlightChars) return renderPlainCode(code, key)

	const resolvedLang = resolveLang(lang)
	try {
		const result = highlighter.codeToTokens(code, {
			lang: resolvedLang,
			themes: {
				light: 'github-light',
				dark: 'github-dark',
			},
			tokenizeMaxLineLength: maxLineLength,
		})
		return (
			<pre
				key={key}
				class={shikiPreClass}
				style={rootStyleFromTokens(result.fg, result.bg)}
			>
				<code>
					{result.tokens.map((line, lineIndex) => (
						<span class="line" key={lineIndex}>
							{line.map((token) => (
								<span
									key={token.offset}
									style={token.htmlStyle ?? { color: token.color }}
								>
									{token.content}
								</span>
							))}
							{lineIndex < result.tokens.length - 1 ? '\n' : null}
						</span>
					))}
				</code>
			</pre>
		)
	} catch {
		return renderPlainCode(code, key)
	}
}
