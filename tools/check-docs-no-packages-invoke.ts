import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { isExecutedDirectly } from './node-runtime.ts'

export type PackagesInvokeMention = {
	file: string
	line: number
	column: number
	excerpt: string
}

/**
 * Author-facing / agent-facing surfaces that must not teach `packages.invoke`
 * except the allowed negation phrase (decision 0037 / #1750).
 */
export const scannedRelativePrefixes: ReadonlyArray<string> = [
	'docs/use/',
	'docs/guides/',
	'packages/worker/src/mcp/instructions/',
	'.agents/',
]

export const scannedRelativeFiles: ReadonlyArray<string> = ['AGENTS.md']

/** Exact present-tense negation allowed by #1750 Ready when. */
export const allowedPackagesInvokePhrasePattern =
	/\bthere is no author-facing\s+(?:\\?`)?packages\.invoke(?:\\?`)?\b/i

const packagesInvokePattern = /packages\.invoke/i

function isScannedRelativePath(relativePath: string): boolean {
	const normalized = relativePath.replaceAll('\\', '/')
	if (scannedRelativeFiles.includes(normalized)) return true
	return scannedRelativePrefixes.some((prefix) => normalized.startsWith(prefix))
}

function blankAllowedPhrases(line: string): string {
	return line.replace(allowedPackagesInvokePhrasePattern, (match) =>
		' '.repeat(match.length),
	)
}

export function findDisallowedPackagesInvokeMentions(input: {
	relativePath: string
	content: string
}): PackagesInvokeMention[] {
	const relativePath = input.relativePath.replaceAll('\\', '/')
	if (!isScannedRelativePath(relativePath)) {
		return []
	}

	const matches: Array<PackagesInvokeMention> = []
	for (const [lineIndex, line] of input.content.split('\n').entries()) {
		const searchable = blankAllowedPhrases(line)
		const match = packagesInvokePattern.exec(searchable)
		if (!match) continue
		matches.push({
			file: relativePath,
			line: lineIndex + 1,
			column: match.index + 1,
			excerpt: line.trim(),
		})
	}
	return matches
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

export async function listPackagesInvokeScanPaths(
	cwd: string = process.cwd(),
): Promise<Array<string>> {
	const paths: Array<string> = [...scannedRelativeFiles]
	for (const prefix of scannedRelativePrefixes) {
		const absolute = path.join(cwd, ...prefix.split('/').filter(Boolean))
		const filePattern = prefix.includes('/mcp/instructions/')
			? /\.ts$/
			: prefix === '.agents/'
				? /\.(?:mdx?|ts)$/
				: /\.mdx?$/
		try {
			paths.push(
				...(await collectMatchingPaths(
					absolute,
					prefix.replace(/\/$/, ''),
					filePattern,
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

export async function checkDocsNoPackagesInvoke(
	cwd: string = process.cwd(),
): Promise<Array<PackagesInvokeMention>> {
	const paths = await listPackagesInvokeScanPaths(cwd)
	const matches: Array<PackagesInvokeMention> = []
	for (const relativePath of paths) {
		matches.push(
			...findDisallowedPackagesInvokeMentions({
				relativePath,
				content: await readFile(path.join(cwd, relativePath), 'utf8'),
			}),
		)
	}
	return matches
}

function formatMatches(matches: ReadonlyArray<PackagesInvokeMention>): string {
	return matches
		.map(
			(match) =>
				`${match.file}:${String(match.line)}:${String(match.column)}: ${match.excerpt}`,
		)
		.join('\n')
}

export async function main(cwd: string = process.cwd()): Promise<void> {
	const matches = await checkDocsNoPackagesInvoke(cwd)
	if (matches.length === 0) {
		console.log('Docs packages.invoke guidance check passed.')
		return
	}

	console.error(
		[
			`Docs packages.invoke guidance check failed (${String(matches.length)} issue(s)).`,
			'Usage docs, guides, MCP instructions, skills, and AGENTS.md must not teach `packages.invoke`.',
			'Allowed only: "There is no author-facing `packages.invoke`."',
			'See docs/contributing/decisions/0037-no-author-packages-invoke.md and #1750.',
			'',
			formatMatches(matches),
		].join('\n'),
	)
	process.exitCode = 1
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
