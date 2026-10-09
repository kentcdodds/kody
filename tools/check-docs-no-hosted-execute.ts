import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { isExecutedDirectly } from './node-runtime.ts'

export type HostedExecuteMention = {
	file: string
	line: number
	column: number
	pattern: string
	excerpt: string
}

/**
 * Agent-facing surfaces that must not recommend hosted MCP `execute` as the
 * fallback when local CLI cannot run. The rule lives in
 * docs/guides/local-execute.md and
 * .agents/skills/prefer-local-cli-execute/SKILL.md.
 */
export const scannedRelativePrefixes: ReadonlyArray<string> = [
	'docs/',
	'.agents/',
	'.cursor/',
	'packages/worker/src/mcp/instructions/',
]

export const scannedRelativeFiles: ReadonlyArray<string> = [
	'AGENTS.md',
	'packages/worker/src/mcp/server-instructions.ts',
	'packages/worker/src/mcp/tools/api.ts',
	'packages/worker/src/mcp/capabilities/packages/create-stub-package.ts',
]

/**
 * Present-tense negations. Blank these before matching so "do not use" and
 * "is banned" stay legal.
 */
const fallBackToMcpExecute =
	/fall(?:\s+|-)back\s+to\s+(?:using\s+)?(?:the\s+)?(?:hosted\s+)?MCP\s+`?execute`?/
		.source

export const allowedHostedExecutePhrasePatterns: ReadonlyArray<RegExp> = [
	/\bdo\s+\*{0,2}not\*{0,2}\s+(?:use|try|call)\s+(?:the\s+)?(?:hosted\s+)?MCP\s+`?execute`?/gi,
	/\bdon't\s+(?:use|try|call)\s+(?:the\s+)?(?:hosted\s+)?MCP\s+`?execute`?/gi,
	/\bnever\s+(?:use|try|call)\s+(?:the\s+)?(?:hosted\s+)?MCP\s+`?execute`?/gi,
	new RegExp(
		String.raw`\bdo\s+\*{0,2}not\*{0,2}\s+${fallBackToMcpExecute}`,
		'gi',
	),
	new RegExp(String.raw`\bdon't\s+${fallBackToMcpExecute}`, 'gi'),
	new RegExp(String.raw`\bnever\s+${fallBackToMcpExecute}`, 'gi'),
	/\bnever\s+hosted\s+MCP\s+`?execute`?/gi,
	/\bhosted\s+MCP\s+`?execute`?\s+is\s+banned\b/gi,
	/\bover\s+hosted\s+MCP\s+`?execute`?/gi,
]

type BannedHostedExecutePattern = {
	label: string
	regex: RegExp
}

export const bannedHostedExecutePatterns: ReadonlyArray<BannedHostedExecutePattern> =
	[
		{
			label: 'fall back to MCP execute',
			regex: new RegExp(String.raw`\b${fallBackToMcpExecute}`, 'i'),
		},
		{
			label: 'use/prefer/call/try hosted MCP execute',
			regex:
				/\b(?:use|prefer|call|try)\s+(?:the\s+)?hosted\s+MCP\s+`?execute`?/i,
		},
		{
			label: 'hosted MCP execute as a fallback',
			regex: /\bhosted\s+MCP\s+`?execute`?\s+as\s+(?:a\s+|the\s+)?fallback\b/i,
		},
		{
			label: 'fallback is hosted MCP execute',
			regex:
				/\bfallback(?:\s+is|:)\s+(?:the\s+|to\s+(?:the\s+)?)?(?:hosted\s+)?MCP\s+`?execute`?/i,
		},
		{
			label: 'otherwise use MCP execute',
			regex:
				/\botherwise\s+(?:use|call|try)\s+(?:the\s+)?(?:hosted\s+)?MCP\s+`?execute`?/i,
		},
		{
			label: 'if local fails, use MCP execute',
			regex:
				/\bif\b[^.]{0,160}?\b(?:cannot|can't|unavailable|fails|failed|missing)\b[^.]{0,100}?\b(?:use|try|call)\s+(?:the\s+)?(?:hosted\s+)?MCP\s+`?execute`?/i,
		},
	]

function isScannedRelativePath(relativePath: string): boolean {
	const normalized = relativePath.replaceAll('\\', '/')
	if (scannedRelativeFiles.includes(normalized)) return true
	return scannedRelativePrefixes.some((prefix) => normalized.startsWith(prefix))
}

function blankAllowedPhrases(line: string): string {
	let searchable = line
	for (const pattern of allowedHostedExecutePhrasePatterns) {
		pattern.lastIndex = 0
		searchable = searchable.replace(pattern, (match) =>
			' '.repeat(match.length),
		)
	}
	return searchable
}

export function findDisallowedHostedExecuteMentions(input: {
	relativePath: string
	content: string
}): HostedExecuteMention[] {
	const relativePath = input.relativePath.replaceAll('\\', '/')
	if (!isScannedRelativePath(relativePath)) {
		return []
	}

	const matches: Array<HostedExecuteMention> = []
	const lines = input.content.split('\n')
	let index = 0
	while (index < lines.length) {
		if (lines[index]?.trim() === '') {
			index += 1
			continue
		}
		const start = index
		while (index < lines.length && lines[index]?.trim() !== '') {
			index += 1
		}
		const block = lines.slice(start, index)
		const searchable = blankAllowedPhrases(block.join(' '))
		for (const pattern of bannedHostedExecutePatterns) {
			pattern.regex.lastIndex = 0
			const match = pattern.regex.exec(searchable)
			if (!match) continue
			const located = locateInBlock(block, match.index)
			const excerptLine = block[located.lineOffset] ?? block[0] ?? ''
			matches.push({
				file: relativePath,
				line: start + located.lineOffset + 1,
				column: located.column,
				pattern: pattern.label,
				excerpt: excerptLine.trim(),
			})
		}
	}
	return matches
}

function locateInBlock(
	block: ReadonlyArray<string>,
	offset: number,
): { lineOffset: number; column: number } {
	let cursor = 0
	for (let lineOffset = 0; lineOffset < block.length; lineOffset += 1) {
		const line = block[lineOffset] ?? ''
		const end = cursor + line.length
		if (offset <= end) {
			return { lineOffset, column: offset - cursor + 1 }
		}
		cursor = end + 1
	}
	return { lineOffset: 0, column: 1 }
}

async function collectMatchingPaths(
	directory: string,
	relativePrefix: string,
	filePattern: RegExp,
): Promise<Array<string>> {
	const entries = await readdir(directory, { withFileTypes: true })
	const paths: Array<string> = []

	for (const entry of entries) {
		const relativePath = `${relativePrefix}/${entry.name}`
		const absolutePath = path.join(directory, entry.name)
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || entry.name === '.git') continue
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

function filePatternForPrefix(prefix: string): RegExp {
	if (prefix.includes('/mcp/instructions/')) return /\.ts$/
	return /\.mdx?$|\.mdc$/
}

export async function listHostedExecuteScanPaths(
	cwd: string = process.cwd(),
): Promise<Array<string>> {
	const paths: Array<string> = []
	for (const relativePath of scannedRelativeFiles) {
		try {
			await readFile(path.join(cwd, relativePath), 'utf8')
			paths.push(relativePath)
		} catch (error) {
			if (
				error &&
				typeof error === 'object' &&
				'code' in error &&
				error.code === 'ENOENT'
			) {
				continue
			}
			throw error
		}
	}
	for (const prefix of scannedRelativePrefixes) {
		const absolute = path.join(cwd, ...prefix.split('/').filter(Boolean))
		try {
			paths.push(
				...(await collectMatchingPaths(
					absolute,
					prefix.replace(/\/$/, ''),
					filePatternForPrefix(prefix),
				)),
			)
		} catch (error) {
			if (
				error &&
				typeof error === 'object' &&
				'code' in error &&
				error.code === 'ENOENT'
			) {
				continue
			}
			throw error
		}
	}
	return [...new Set(paths)].sort()
}

export async function checkDocsNoHostedExecute(
	cwd: string = process.cwd(),
): Promise<Array<HostedExecuteMention>> {
	const paths = await listHostedExecuteScanPaths(cwd)
	const matches: Array<HostedExecuteMention> = []
	for (const relativePath of paths) {
		matches.push(
			...findDisallowedHostedExecuteMentions({
				relativePath,
				content: await readFile(path.join(cwd, relativePath), 'utf8'),
			}),
		)
	}
	return matches
}

function formatMatches(matches: ReadonlyArray<HostedExecuteMention>): string {
	return matches
		.map(
			(match) =>
				`${match.file}:${String(match.line)}:${String(match.column)} (${match.pattern}): ${match.excerpt}`,
		)
		.join('\n')
}

export async function main(cwd: string = process.cwd()): Promise<void> {
	const matches = await checkDocsNoHostedExecute(cwd)
	if (matches.length === 0) {
		console.log('Docs hosted-execute fallback check passed.')
		return
	}

	console.error(
		[
			`Docs hosted-execute fallback check failed (${String(matches.length)} issue(s)).`,
			'Guides, skills, and MCP instructions must not recommend hosted MCP execute as the fallback.',
			'Point at docs/guides/local-execute.md (guide:local_execute) and .agents/skills/prefer-local-cli-execute/SKILL.md.',
			'Allowed negations include "Do not use hosted MCP execute", "hosted MCP execute is banned", and "over hosted MCP execute".',
			'If --local cannot run, say to use Open API / MCP api or to fix the environment.',
			'',
			formatMatches(matches),
		].join('\n'),
	)
	process.exitCode = 1
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
