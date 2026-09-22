/**
 * Line anchors on file and guide text. `#L165` is one line plus surrounding
 * context. `#L165-L180` is that inclusive range. Uppercase `L` keeps these
 * distinct from lowercase heading slugs such as `l165`.
 */

const lineAnchorPattern = /^L(\d+)(?:-L(\d+))?$/

/** Lines of context on each side of a single-line anchor (`#L165`). */
const lineAnchorContextLines = 20

export class FileAnchorError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'FileAnchorError'
	}
}

export type ParsedLineAnchor =
	| { status: 'absent' }
	| { status: 'invalid'; message: string }
	| { status: 'ok'; startLine: number; endLine: number }

export function parseLineAnchor(fragment: string): ParsedLineAnchor {
	const trimmed = fragment.trim()
	const match = lineAnchorPattern.exec(trimmed)
	if (!match) return { status: 'absent' }
	const startLine = Number(match[1])
	const endLine = match[2] == null ? startLine : Number(match[2])
	if (
		!Number.isSafeInteger(startLine) ||
		!Number.isSafeInteger(endLine) ||
		startLine < 1 ||
		endLine < 1
	) {
		return {
			status: 'invalid',
			message: 'Line numbers start at 1. Use #L165 or #L165-L180.',
		}
	}
	if (endLine < startLine) {
		return {
			status: 'invalid',
			message: `Line range L${String(startLine)}-L${String(endLine)} must start at or before the end line.`,
		}
	}
	return { status: 'ok', startLine, endLine }
}

export function formatRequestedLineLabel(input: {
	requestedStartLine: number
	requestedEndLine: number
}) {
	if (input.requestedStartLine === input.requestedEndLine) {
		return `L${String(input.requestedStartLine)}`
	}
	return `L${String(input.requestedStartLine)}-L${String(input.requestedEndLine)}`
}

/** Editor line count: a trailing newline does not add a blank line. */
export function splitSourceLines(content: string) {
	const normalized = content.replace(/\r\n/g, '\n')
	if (normalized.length === 0) return []
	const body = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized
	return body.split('\n')
}

export function formatLineExcerpt(input: {
	label: string
	lines: ReadonlyArray<string>
	startLine: number
	endLine: number
	maxChars?: number
}) {
	const totalLines = input.lines.length
	const requestedLabel = formatRequestedLineLabel({
		requestedStartLine: input.startLine,
		requestedEndLine: input.endLine,
	})
	if (totalLines === 0) {
		throw new FileAnchorError(`${input.label} is empty.`)
	}
	if (input.startLine > totalLines || input.endLine > totalLines) {
		const span =
			input.startLine === input.endLine
				? `Line ${String(input.startLine)}`
				: `Line range ${requestedLabel}`
		throw new FileAnchorError(
			`${span} is past the end of ${input.label} (${String(totalLines)} ${totalLines === 1 ? 'line' : 'lines'}).`,
		)
	}
	const pad = input.endLine === input.startLine ? lineAnchorContextLines : 0
	const windowStart = Math.max(1, input.startLine - pad)
	const windowEnd = Math.min(totalLines, input.endLine + pad)
	const width = String(totalLines).length
	const numbered = input.lines
		.slice(windowStart - 1, windowEnd)
		.map((line, index) => {
			const lineNo = String(windowStart + index).padStart(width, ' ')
			return `${lineNo}|${line}`
		})
	const contextNote =
		pad > 0 ? ' Context is included around the requested line.' : ''
	const header = [
		input.label,
		`Showing lines ${String(windowStart)}-${String(windowEnd)} of ${String(totalLines)}. Requested ${requestedLabel}.${contextNote}`,
	].join('\n')
	const bounded = boundAnchoredText({
		text: `${header}\n\n${numbered.join('\n')}`,
		maxChars: input.maxChars,
		tighterHint: `Open a tighter range with #${requestedLabel}.`,
	})
	return {
		content: bounded.text,
		truncated: bounded.truncated,
		startLine: windowStart,
		endLine: windowEnd,
		requestedStartLine: input.startLine,
		requestedEndLine: input.endLine,
		totalLines,
	}
}

export function boundAnchoredText(input: {
	text: string
	maxChars?: number
	tighterHint: string
}) {
	if (input.maxChars == null || input.text.length <= input.maxChars) {
		return { text: input.text, truncated: false }
	}
	const footer = `\n\n--- TRUNCATED ---\nThis region is larger than the response budget. ${input.tighterHint}`
	const budget = Math.max(0, input.maxChars - footer.length)
	let text = `${input.text.slice(0, budget).trimEnd()}${footer}`
	if (text.length > input.maxChars) {
		text = text.slice(0, input.maxChars)
	}
	return { text, truncated: true }
}
