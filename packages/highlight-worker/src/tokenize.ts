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
import { createHighlighterCoreSync } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import {
	plainHighlightedCode,
	type HighlightedCode,
	type HighlightedSpan,
	type HighlightSnippet,
} from '../../worker/universal/highlighted-code.ts'

/**
 * Fine-grained Shiki bundle for first-party pages and markdown code fences.
 *
 * Worker constraints:
 * - JavaScript regex engine (no Oniguruma WASM)
 * - Explicit langs/themes only
 * - Tokens are serializable data (never HTML strings)
 */
let highlighter: ReturnType<typeof createHighlighterCoreSync> | null = null

function getHighlighter() {
	if (!highlighter) {
		highlighter = createHighlighterCoreSync({
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
	}
	return highlighter
}

const maxHighlightChars = 50_000
const maxLineLength = 2_000

function normalizeLang(lang: string | null | undefined): string {
	const trimmed = lang?.trim().toLowerCase() ?? ''
	if (!trimmed) return 'plaintext'
	const primary = trimmed.split(/[\s{,]+/, 1)[0] ?? 'plaintext'
	return primary || 'plaintext'
}

const langAliases: Record<string, string> = {
	js: 'ts',
	javascript: 'ts',
	cjs: 'ts',
	mjs: 'ts',
	jsx: 'tsx',
	sh: 'shellscript',
	bash: 'shellscript',
	shell: 'shellscript',
	zsh: 'shellscript',
	golang: 'go',
	env: 'dotenv',
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
	return getHighlighter().getLoadedLanguages().includes(aliased)
		? aliased
		: 'plaintext'
}

function tokenStyle(token: {
	htmlStyle?: string | Record<string, string>
	color?: string
}): Record<string, string> | undefined {
	if (token.htmlStyle && typeof token.htmlStyle === 'object') {
		return token.htmlStyle
	}
	if (typeof token.htmlStyle === 'string' && token.htmlStyle.trim()) {
		const style: Record<string, string> = {}
		for (const part of token.htmlStyle.split(';')) {
			const separator = part.indexOf(':')
			if (separator <= 0) continue
			style[part.slice(0, separator).trim()] = part.slice(separator + 1).trim()
		}
		if (Object.keys(style).length > 0) return style
	}
	if (token.color) return { color: token.color }
	return undefined
}

export function tokenizeSnippet(snippet: HighlightSnippet): HighlightedCode {
	const code = snippet.code
	if (code.length > maxHighlightChars) {
		return plainHighlightedCode(code, snippet.lang)
	}
	const resolvedLang = resolveLang(snippet.lang)
	if (resolvedLang === 'plaintext') {
		return plainHighlightedCode(code, snippet.lang)
	}
	try {
		const result = getHighlighter().codeToTokens(code, {
			lang: resolvedLang,
			themes: {
				light: 'github-light',
				dark: 'github-dark',
			},
			tokenizeMaxLineLength: maxLineLength,
		})
		return {
			code,
			lang: resolvedLang,
			plain: false,
			fg: result.fg,
			bg: result.bg,
			lines: result.tokens.map((line) =>
				line.map((token) => {
					const span: HighlightedSpan = { content: token.content }
					const style = tokenStyle(token)
					if (style) span.style = style
					return span
				}),
			),
		}
	} catch {
		return plainHighlightedCode(code, snippet.lang)
	}
}

export function tokenizeSnippets(
	snippets: Array<HighlightSnippet>,
): Array<HighlightedCode> {
	return snippets.map((snippet) => tokenizeSnippet(snippet))
}
