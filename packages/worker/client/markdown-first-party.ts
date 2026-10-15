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

function blockquoteMarker(token: Token, marker: RegExp) {
	if (token.type !== 'blockquote') return null
	const first = token.tokens?.[0]
	if (first?.type !== 'paragraph' || typeof first.text !== 'string') return null
	return marker.exec(first.text.trimStart())
}

export function firstPartyAlertKind(token: Token): FirstPartyAlertKind | null {
	const match = blockquoteMarker(token, alertMarkerRe)
	return match ? (match[1] as FirstPartyAlertKind) : null
}

export function stripFirstPartyAlertMarker(
	tokens: Array<Token> | undefined,
): Array<Token> {
	return stripLeadingMarker(tokens, alertMarkerRe)
}

/**
 * `> [!DIAGRAM] <id>` names a first-party figure the docs renderer draws;
 * the rest of the blockquote is its caption. Raw markdown keeps the caption
 * as a plain blockquote, so agents still read what the figure shows.
 */
const diagramMarkerRe = /^\[!DIAGRAM\][ \t]+([a-z0-9-]+)\s*/

export function firstPartyDiagramId(token: Token): string | null {
	return blockquoteMarker(token, diagramMarkerRe)?.[1] ?? null
}

export function stripFirstPartyDiagramMarker(
	tokens: Array<Token> | undefined,
): Array<Token> {
	return stripLeadingMarker(tokens, diagramMarkerRe)
}

function stripLeadingMarker(
	tokens: Array<Token> | undefined,
	marker: RegExp,
): Array<Token> {
	if (!tokens?.length) return []
	const [first, ...rest] = tokens
	if (first?.type !== 'paragraph' || typeof first.text !== 'string') {
		return tokens
	}
	const stripped = first.text.trimStart().replace(marker, '')
	if (stripped === first.text) return tokens
	const nextTokens = first.tokens?.length
		? stripMarkerFromInline(first.tokens, marker)
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

function stripMarkerFromInline(
	tokens: Array<Token>,
	marker: RegExp,
): Array<Token> {
	const [first, ...rest] = tokens
	if (first?.type !== 'text' || typeof first.text !== 'string') return tokens
	const stripped = first.text.trimStart().replace(marker, '')
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
