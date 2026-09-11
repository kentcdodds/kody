import { type Token } from 'marked'

/**
 * First-party guide / blog extras. Untrusted markdown never uses these
 * parsers — raw HTML stays escaped there.
 */

const firstPartyAlertKinds = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING'] as const

export type FirstPartyAlertKind = (typeof firstPartyAlertKinds)[number]

export type FirstPartyDetailsToken = {
	type: 'first-party-details'
	summary: string
	tokens: Array<Token>
	raw: string
}

const detailsOpenRe = /^\s*<details(?:\s+open)?\s*>/i
const detailsCloseRe = /<\/details\s*>/i
const summaryRe = /^<summary\s*>([\s\S]*?)<\/summary\s*>/i
const alertMarkerRe = /^\[!(NOTE|TIP|IMPORTANT|WARNING)\][ \t]*/

export function isFirstPartyDetailsToken(
	token: Token,
): token is Token & FirstPartyDetailsToken {
	return token.type === 'first-party-details'
}

function stripTags(value: string): string {
	return value.replace(/<[^>]+>/g, '').trim()
}

function parseFirstPartyDetails(
	raw: string,
): { summary: string; body: string } | null {
	const trimmed = raw.trim()
	const open = detailsOpenRe.exec(trimmed)
	if (!open || open.index !== 0) return null
	const closeMatch = detailsCloseRe.exec(trimmed)
	if (!closeMatch || closeMatch.index + closeMatch[0].length !== trimmed.length)
		return null
	const inner = trimmed.slice(open[0].length, closeMatch.index).trim()
	if (/<\/?details\b/i.test(inner)) return null
	const summaryMatch = summaryRe.exec(inner)
	const summaryText = summaryMatch?.[1]
	if (!summaryMatch || !summaryText) return null
	const summary = stripTags(summaryText)
	if (!summary) return null
	return { summary, body: inner.slice(summaryMatch[0].length).trim() }
}

/**
 * Coalesce CommonMark HTML-block splits (`<details>` ends at the first blank
 * line) into one first-party details token. Anything that is not a bare
 * `<details>` / `<details open>` with a `<summary>` stays as the original
 * tokens so it renders as escaped text.
 */
export function coalesceFirstPartyDetails(
	tokens: Array<Token>,
	lexBody: (markdown: string) => Array<Token>,
): Array<Token> {
	const out: Array<Token> = []
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]
		if (!token) continue
		if (token.type !== 'html' || !detailsOpenRe.test(token.raw)) {
			out.push(token)
			continue
		}
		let raw = token.raw
		let end = index
		while (!detailsCloseRe.test(raw) && end + 1 < tokens.length) {
			end += 1
			raw += tokens[end]?.raw ?? ''
		}
		const parsed = parseFirstPartyDetails(raw)
		if (!parsed) {
			out.push(token)
			continue
		}
		out.push({
			type: 'first-party-details',
			summary: parsed.summary,
			tokens: parsed.body ? lexBody(parsed.body) : [],
			raw,
		} satisfies FirstPartyDetailsToken as Token)
		index = end
	}
	return out
}

export function firstPartyAlertKind(token: Token): FirstPartyAlertKind | null {
	if (token.type !== 'blockquote') return null
	const first = token.tokens?.[0]
	if (first?.type !== 'paragraph' || typeof first.text !== 'string') return null
	const match = alertMarkerRe.exec(first.text.trimStart())
	if (!match) return null
	return match[1] as FirstPartyAlertKind
}

export function stripFirstPartyAlertMarker(
	tokens: Array<Token> | undefined,
): Array<Token> {
	if (!tokens?.length) return []
	const [first, ...rest] = tokens
	if (first?.type !== 'paragraph' || typeof first.text !== 'string') {
		return tokens
	}
	const stripped = first.text.trimStart().replace(alertMarkerRe, '')
	if (stripped === first.text) return tokens
	const nextTokens = first.tokens?.length
		? stripAlertMarkerFromInline(first.tokens)
		: first.tokens
	return [
		{
			...first,
			text: stripped,
			...(nextTokens ? { tokens: nextTokens } : {}),
		},
		...rest,
	]
}

function stripAlertMarkerFromInline(tokens: Array<Token>): Array<Token> {
	const [first, ...rest] = tokens
	if (first?.type !== 'text' || typeof first.text !== 'string') return tokens
	const stripped = first.text.trimStart().replace(alertMarkerRe, '')
	if (!stripped) return rest
	return [{ ...first, text: stripped }, ...rest]
}

export function firstPartyAlertLabel(kind: FirstPartyAlertKind): string {
	switch (kind) {
		case 'NOTE':
			return 'Note'
		case 'TIP':
			return 'Tip'
		case 'IMPORTANT':
			return 'Important'
		case 'WARNING':
			return 'Warning'
		default: {
			const exhaustive: never = kind
			return exhaustive
		}
	}
}
