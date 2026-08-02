import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { isExecutedDirectly } from './node-runtime.ts'

export type TemporalLanguageMatch = {
	file: string
	line: number
	column: number
	pattern: string
	excerpt: string
}

type TemporalLanguagePattern = {
	label: string
	regex: RegExp
}

/** These pages intentionally discuss or demonstrate time-dependent wording. */
export const exemptRelativePaths = new Set([
	'docs/contributing/documentation.md',
	'docs/contributing/secret-rotation.md',
	// Point-in-time migration audit; temporal phrasing is expected.
	'docs/contributing/architecture/capability-and-primitive-audit-2026-07.md',
])

/** Directories whose pages are intentionally point-in-time records. */
export const exemptRelativePrefixes: ReadonlyArray<string> = [
	'docs/contributing/decisions/',
]

/**
 * Changelog-style phrases to flag in durable documentation.
 * Keep this list narrow and aligned with docs/contributing/documentation.md.
 */
export const temporalLanguagePatterns: ReadonlyArray<TemporalLanguagePattern> =
	[
		{ label: 'now we', regex: /\bnow we\b/i },
		{ label: 'we now', regex: /\bwe now\b/i },
		{ label: 'we no longer', regex: /\bwe no longer\b/i },
		{ label: 'Kody now', regex: /\bKody now\b/i },
		{ label: 'previously we', regex: /\bpreviously we\b/i },
		{ label: 'formerly we', regex: /\bformerly we\b/i },
		{ label: 'as before', regex: /\bas before\b/i },
		{
			label: 'were removed',
			regex: /\bwere(?:\s+\*{1,2})?\s*removed\b(?:\*{1,2})?/i,
		},
		{
			label:
				'no longer support/accept/require/use/fan/carry/replay/incur/authoritative/insert/needed',
			regex:
				/\bno longer (?:support|accept|require|use|fan|carry|replay|incur|authoritative|insert|needed)s?\b/i,
		},
		{
			label: 'now support/accept/require/use/store/return/call/read',
			regex: /\bnow (?:support|accept|require|use|store|return|call|read)s?\b/i,
		},
		{ label: 'is now the', regex: /\bis now the\b/i },
		{ label: 'are now', regex: /\bare now\b/i },
		{ label: 'previously a/the', regex: /\bpreviously (?:a|the)\b/i },
		{
			label: 'recently changed/added/updated/removed/introduced',
			regex: /\brecently (?:changed|added|updated|removed|introduced)\b/i,
		},
		{
			label: 'used to support/require',
			regex: /\bused to (?:support|require)\b/i,
		},
	]

function blankPreservingNewlines(value: string): string {
	return value.replace(/[^\r\n]/g, ' ')
}

function maskInlineCode(line: string): string {
	const characters = line.split('')
	let cursor = 0

	while (cursor < line.length) {
		if (line[cursor] !== '`') {
			cursor += 1
			continue
		}

		let openingEnd = cursor
		while (line[openingEnd] === '`') {
			openingEnd += 1
		}
		const delimiterLength = openingEnd - cursor
		let searchFrom = openingEnd
		let closingEnd: number | null = null

		while (searchFrom < line.length) {
			const closingStart = line.indexOf('`', searchFrom)
			if (closingStart === -1) {
				break
			}
			let candidateEnd = closingStart
			while (line[candidateEnd] === '`') {
				candidateEnd += 1
			}
			if (candidateEnd - closingStart === delimiterLength) {
				closingEnd = candidateEnd
				break
			}
			searchFrom = candidateEnd
		}

		if (closingEnd === null) {
			cursor = openingEnd
			continue
		}
		characters.fill(' ', cursor, closingEnd)
		cursor = closingEnd
	}

	return characters.join('')
}

export function stripMarkdownCode(content: string): string {
	const parts = content.split(/(\r\n|\r|\n)/)
	let openFence: { character: string; length: number } | null = null

	for (let index = 0; index < parts.length; index += 2) {
		const line = parts[index]
		if (line === undefined) {
			continue
		}

		if (openFence) {
			const closingFence = /^[ \t]{0,3}(?<fence>`{3,}|~{3,})[ \t]*$/.exec(line)
				?.groups?.fence
			parts[index] = blankPreservingNewlines(line)
			if (
				closingFence?.[0] === openFence.character &&
				closingFence.length >= openFence.length
			) {
				openFence = null
			}
			continue
		}

		const openingFence = /^[ \t]{0,3}(?<fence>`{3,}|~{3,})/.exec(line)?.groups
			?.fence
		if (openingFence) {
			openFence = {
				character: openingFence[0] ?? '',
				length: openingFence.length,
			}
			parts[index] = blankPreservingNewlines(line)
			continue
		}

		parts[index] = maskInlineCode(line)
	}

	return parts.join('')
}

export function findTemporalLanguageMatches(input: {
	relativePath: string
	content: string
}): TemporalLanguageMatch[] {
	const relativePath = input.relativePath.replaceAll('\\', '/')
	if (
		exemptRelativePaths.has(relativePath) ||
		exemptRelativePrefixes.some((prefix) => relativePath.startsWith(prefix))
	) {
		return []
	}

	const prose = /\.mdx?$/.test(relativePath)
		? stripMarkdownCode(input.content)
		: input.content
	const matches: Array<TemporalLanguageMatch> = []

	for (const [lineIndex, line] of prose.split('\n').entries()) {
		for (const pattern of temporalLanguagePatterns) {
			const match = pattern.regex.exec(line)
			if (!match) {
				continue
			}
			matches.push({
				file: relativePath,
				line: lineIndex + 1,
				column: match.index + 1,
				pattern: pattern.label,
				excerpt: line.trim(),
			})
		}
	}

	return matches
}

async function collectMatchingPaths(
	directory: string,
	relativePrefix: string,
	filePattern: RegExp = /\.mdx?$/,
): Promise<Array<string>> {
	const entries = await readdir(directory, { withFileTypes: true })
	const paths: Array<string> = []

	for (const entry of entries) {
		const relativePath = `${relativePrefix}/${entry.name}`
		const absolutePath = path.join(directory, entry.name)
		if (entry.isDirectory()) {
			paths.push(
				...(await collectMatchingPaths(
					absolutePath,
					relativePath,
					filePattern,
				)),
			)
		} else if (entry.isFile() && filePattern.test(entry.name)) {
			paths.push(relativePath.replaceAll('\\', '/'))
		}
	}

	return paths
}

export async function listDocumentationPaths(
	cwd: string = process.cwd(),
): Promise<Array<string>> {
	const paths = [
		'README.md',
		'AGENTS.md',
		'packages/worker/src/mcp/server-instructions.ts',
	]
	for (const root of ['docs', '.agents']) {
		paths.push(...(await collectMatchingPaths(path.join(cwd, root), root)))
	}
	const instructionsRoot = path.join(
		'packages',
		'worker',
		'src',
		'mcp',
		'instructions',
	)
	paths.push(
		...(await collectMatchingPaths(
			path.join(cwd, instructionsRoot),
			instructionsRoot,
			/\.ts$/,
		)),
	)
	return [...new Set(paths)].sort()
}

export async function checkDocumentationTemporalLanguage(
	cwd: string = process.cwd(),
): Promise<Array<TemporalLanguageMatch>> {
	const paths = await listDocumentationPaths(cwd)
	const matches: Array<TemporalLanguageMatch> = []

	for (const relativePath of paths) {
		matches.push(
			...findTemporalLanguageMatches({
				relativePath,
				content: await readFile(path.join(cwd, relativePath), 'utf8'),
			}),
		)
	}

	return matches
}

function formatMatches(matches: ReadonlyArray<TemporalLanguageMatch>): string {
	return matches
		.map(
			(match) =>
				`${match.file}:${String(match.line)}:${String(match.column)} (${match.pattern}): ${match.excerpt}`,
		)
		.join('\n')
}

export async function main(cwd: string = process.cwd()): Promise<void> {
	const matches = await checkDocumentationTemporalLanguage(cwd)
	if (matches.length === 0) {
		console.log('Docs temporal-language check passed.')
		return
	}

	console.error(
		[
			`Docs temporal-language check failed (${String(matches.length)} issue(s)).`,
			'Documentation should describe current behavior, not rollouts.',
			'See docs/contributing/documentation.md.',
			'',
			formatMatches(matches),
		].join('\n'),
	)
	process.exitCode = 1
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
