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
])

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
		{
			label: 'no longer support/accept/require/use',
			regex: /\bno longer (?:support|accept|require|use)s?\b/i,
		},
		{
			label: 'now support/accept/require/use/store/return',
			regex: /\bnow (?:support|accept|require|use|store|return)s?\b/i,
		},
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
	return value.replace(/[^\r\n]/g, '')
}

export function stripMarkdownCode(content: string): string {
	const withoutFencedCode = content.replace(
		/(?:^|\n)[ \t]*(?:```|~~~)[^\n]*(?:\n[\s\S]*?(?:^|\n)[ \t]*(?:```|~~~)[ \t]*(?=\n|$)|$)/g,
		blankPreservingNewlines,
	)
	return withoutFencedCode.replace(/`[^`\n]+`/g, '')
}

export function findTemporalLanguageMatches(input: {
	relativePath: string
	content: string
}): TemporalLanguageMatch[] {
	const relativePath = input.relativePath.replaceAll('\\', '/')
	if (exemptRelativePaths.has(relativePath)) {
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

async function collectMarkdownPaths(
	directory: string,
	relativePrefix: string,
): Promise<Array<string>> {
	const entries = await readdir(directory, { withFileTypes: true })
	const paths: Array<string> = []

	for (const entry of entries) {
		const relativePath = `${relativePrefix}/${entry.name}`
		const absolutePath = path.join(directory, entry.name)
		if (entry.isDirectory()) {
			paths.push(...(await collectMarkdownPaths(absolutePath, relativePath)))
		} else if (entry.isFile() && /\.mdx?$/.test(entry.name)) {
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
		paths.push(...(await collectMarkdownPaths(path.join(cwd, root), root)))
	}
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
