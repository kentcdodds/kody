import {
	findDocumentHeading,
	parseDocumentHeadings,
} from '#worker/guides/document-sections.ts'

import {
	boundAnchoredText,
	FileAnchorError,
	formatLineExcerpt,
	parseLineAnchor,
	splitSourceLines,
} from './line-anchor.ts'

export { FileAnchorError } from './line-anchor.ts'

export type FileTextAnchor = {
	kind: 'lines' | 'heading'
	requested: string
	startLine: number
	endLine: number
	requestedStartLine: number
	requestedEndLine: number
	totalLines: number
	heading: {
		title: string
		slug: string
		level: number
	} | null
}

const markdownPathPattern = /\.(?:md|mdx|markdown)$/i

function isMarkdownPath(path: string) {
	return markdownPathPattern.test(path)
}

/**
 * Split `path#fragment` on the first `#`. The fragment is URI-decoded.
 * An empty fragment is an error so callers cannot ignore a dangling `#`.
 */
export function splitFileAnchor(spec: string) {
	const hash = spec.indexOf('#')
	if (hash < 0) return { path: spec, fragment: null as string | null }
	const path = spec.slice(0, hash)
	if (!path.trim()) {
		throw new FileAnchorError('File path before "#" must not be empty.')
	}
	const decoded = decodeFileFragment(spec.slice(hash + 1))
	if (!decoded) {
		throw new FileAnchorError(
			`File fragment after ${JSON.stringify(path)}# must not be empty.`,
		)
	}
	return { path, fragment: decoded }
}

export function readAnchoredText(input: {
	path: string
	content: string
	fragment: string
	maxChars?: number
}): { content: string; truncated: boolean; anchor: FileTextAnchor } {
	const requested = input.fragment.trim()
	const label = `${input.path}#${requested}`
	const parsed = parseLineAnchor(requested)
	if (parsed.status === 'invalid') {
		throw new FileAnchorError(parsed.message)
	}
	if (parsed.status === 'ok') {
		const excerpt = formatLineExcerpt({
			label,
			lines: splitSourceLines(input.content),
			startLine: parsed.startLine,
			endLine: parsed.endLine,
			maxChars: input.maxChars,
		})
		return {
			content: excerpt.content,
			truncated: excerpt.truncated,
			anchor: {
				kind: 'lines',
				requested,
				startLine: excerpt.startLine,
				endLine: excerpt.endLine,
				requestedStartLine: excerpt.requestedStartLine,
				requestedEndLine: excerpt.requestedEndLine,
				totalLines: excerpt.totalLines,
				heading: null,
			},
		}
	}
	if (!isMarkdownPath(input.path)) {
		throw new FileAnchorError(
			`Heading anchor ${JSON.stringify(requested)} is not supported on ${input.path}. Use #L165 or #L165-L180.`,
		)
	}
	return readMarkdownHeading({
		path: input.path,
		content: input.content,
		fragment: requested,
		maxChars: input.maxChars,
	})
}

function readMarkdownHeading(input: {
	path: string
	content: string
	fragment: string
	maxChars?: number
}) {
	const headings = parseDocumentHeadings(input.content)
	const selected = findDocumentHeading(headings, input.fragment)
	if (!selected) {
		const available = headings.map((heading) => heading.slug).join(', ')
		throw new FileAnchorError(
			`Unknown heading ${JSON.stringify(input.fragment)} for ${input.path}. Available: ${available || 'none'}.`,
		)
	}
	const lines = splitSourceLines(input.content)
	const startIndex = selected.start
	const endIndex = Math.min(
		Math.max(selected.end, startIndex + 1),
		lines.length,
	)
	const section = lines.slice(startIndex, endIndex)
	const startLine = startIndex + 1
	const endLine = startLine + section.length - 1
	const totalLines = lines.length
	const preface = [
		`${input.path}#${selected.slug}`,
		`Showing ${selected.title} (lines ${String(startLine)}-${String(endLine)} of ${String(totalLines)}).`,
	].join('\n')
	const bounded = boundAnchoredText({
		text: `${preface}\n\n${section.join('\n')}`,
		maxChars: input.maxChars,
		tighterHint: `Open a line range inside this heading with #L${String(startLine)}-L${String(endLine)}.`,
	})
	return {
		content: bounded.text,
		truncated: bounded.truncated,
		anchor: {
			kind: 'heading' as const,
			requested: input.fragment,
			startLine,
			endLine,
			requestedStartLine: startLine,
			requestedEndLine: endLine,
			totalLines,
			heading: {
				title: selected.title,
				slug: selected.slug,
				level: selected.level,
			},
		},
	}
}

function decodeFileFragment(raw: string) {
	const trimmed = raw.trim()
	if (!trimmed) return ''
	try {
		return decodeURIComponent(trimmed).trim()
	} catch {
		return trimmed
	}
}
