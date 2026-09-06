import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { isExecutedDirectly } from './node-runtime.ts'

export type TautologicalAbsenceMatch = {
	file: string
	line: number
	needle: string
}

type QuotedString = {
	decoded: string
	rawInner: string
	end: number
}

type ContainCall = {
	kind: 'absent' | 'present'
	line: number
	start: number
	end: number
	quoted: QuotedString
}

const skipDirectoryNames = new Set([
	'.git',
	'.tmp',
	'.wrangler',
	'build',
	'coverage',
	'dist',
	'node_modules',
	'tmp',
])

const scannedFilePattern = /\.(?:[cm]?[jt]sx?)$/
const testFilePattern = /\.(?:test|spec)\.[^.]+$/
const absenceMatcherPattern =
	/\.not\.(?:toContain|toContainText|toHaveTextContent)\(\s*/g
const presentMatcherPattern =
	/(?<!not)\.(?:toContain|toContainText|toHaveTextContent)\(\s*/g

/** Shared prefix long enough to treat two needles as the same template family. */
export const siblingPrefixLength = 16

const skipDirectoryPrefixes: ReadonlyArray<string> = ['e2e/playwright-report/']

export function isTestPath(relativePath: string) {
	return testFilePattern.test(relativePath) || relativePath.startsWith('e2e/')
}

export function isInstructionalCopyNeedle(decoded: string, rawInner: string) {
	const trimmed = decoded.trim()
	if (!/[A-Za-z]/.test(trimmed) || !/\s/.test(trimmed)) return false
	if (/[<>]/.test(trimmed)) return false
	if (/^&[a-z]+;/i.test(trimmed) || /&[a-z]+;/i.test(trimmed)) return false
	if (/^(data-|href=|action=|id=|class=|aria-|src=|style=)/.test(trimmed)) {
		return false
	}
	if (/^https?:\/\//.test(trimmed)) return false
	if (/<script|javascript:|onerror=/i.test(trimmed)) return false
	if (/\\u[0-9a-f]{4}/i.test(rawInner) || /\\x[0-9a-f]{2}/i.test(rawInner)) {
		return false
	}
	const words = trimmed.split(/\s+/).filter(Boolean)
	const titleCaseLabel =
		words.length === 2 && words.every((word) => /^[A-Z]/.test(word))
	return words.length >= 3 || titleCaseLabel || /[.!?…]$/.test(trimmed)
}

export function longestCommonPrefixLength(left: string, right: string) {
	const limit = Math.min(left.length, right.length)
	let index = 0
	while (index < limit && left[index] === right[index]) index += 1
	return index
}

function readQuotedString(
	source: string,
	quoteIndex: number,
): QuotedString | null {
	const quote = source[quoteIndex]
	if (quote !== "'" && quote !== '"' && quote !== '`') return null
	let index = quoteIndex + 1
	let decoded = ''
	while (index < source.length) {
		const char = source[index]
		if (quote === '`' && char === '$' && source[index + 1] === '{') {
			return null
		}
		if (char === '\\') {
			const escaped = readEscape(source, index + 1)
			if (!escaped) return null
			decoded += escaped.value
			index = escaped.end
			continue
		}
		if (char === quote) {
			return {
				decoded,
				rawInner: source.slice(quoteIndex + 1, index),
				end: index + 1,
			}
		}
		decoded += char
		index += 1
	}
	return null
}

function readEscape(
	source: string,
	index: number,
): { value: string; end: number } | null {
	const char = source[index]
	if (!char) return null
	switch (char) {
		case 'n':
			return { value: '\n', end: index + 1 }
		case 'r':
			return { value: '\r', end: index + 1 }
		case 't':
			return { value: '\t', end: index + 1 }
		case 'b':
			return { value: '\b', end: index + 1 }
		case 'f':
			return { value: '\f', end: index + 1 }
		case 'v':
			return { value: '\v', end: index + 1 }
		case '0':
			return { value: '\0', end: index + 1 }
		case 'x': {
			const hex = source.slice(index + 1, index + 3)
			if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null
			return {
				value: String.fromCharCode(Number.parseInt(hex, 16)),
				end: index + 3,
			}
		}
		case 'u': {
			if (source[index + 1] === '{') {
				const close = source.indexOf('}', index + 2)
				if (close === -1) return null
				const hex = source.slice(index + 2, close)
				if (!/^[0-9a-fA-F]+$/.test(hex)) return null
				return {
					value: String.fromCodePoint(Number.parseInt(hex, 16)),
					end: close + 1,
				}
			}
			const hex = source.slice(index + 1, index + 5)
			if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null
			return {
				value: String.fromCharCode(Number.parseInt(hex, 16)),
				end: index + 5,
			}
		}
		default:
			return { value: char, end: index + 1 }
	}
}

function lineNumberAt(source: string, index: number) {
	return source.slice(0, index).split('\n').length
}

export function findContainCalls(content: string): Array<ContainCall> {
	const calls: Array<ContainCall> = []
	for (const [kind, pattern] of [
		['absent', absenceMatcherPattern],
		['present', presentMatcherPattern],
	] as const) {
		pattern.lastIndex = 0
		let match = pattern.exec(content)
		while (match) {
			const quoted = readQuotedString(content, match.index + match[0].length)
			if (quoted) {
				calls.push({
					kind,
					line: lineNumberAt(content, match.index),
					start: match.index,
					end: quoted.end,
					quoted,
				})
			}
			match = pattern.exec(content)
		}
	}
	return calls
}

function blankAbsenceSpans(
	content: string,
	needle: string,
	calls: ReadonlyArray<ContainCall>,
) {
	let next = content
	for (const call of [...calls].reverse()) {
		if (call.kind !== 'absent' || call.quoted.decoded !== needle) continue
		next = `${next.slice(0, call.start)}${' '.repeat(call.end - call.start)}${next.slice(call.end)}`
	}
	return next
}

function mentionsNeedle(
	content: string,
	needle: { decoded: string; rawInner: string },
) {
	return content.includes(needle.decoded) || content.includes(needle.rawInner)
}

export function findTautologicalAbsenceMatches(input: {
	relativePath: string
	content: string
	otherContents: ReadonlyArray<string>
}): Array<TautologicalAbsenceMatch> {
	if (!isTestPath(input.relativePath)) return []
	const calls = findContainCalls(input.content)
	const presentNeedles = calls
		.filter((call) => call.kind === 'present')
		.map((call) => call.quoted.decoded)
	const matches: Array<TautologicalAbsenceMatch> = []
	const seen = new Set<string>()

	for (const call of calls) {
		if (call.kind !== 'absent') continue
		const { decoded, rawInner } = call.quoted
		if (!isInstructionalCopyNeedle(decoded, rawInner)) continue
		if (seen.has(decoded)) continue
		if (
			presentNeedles.some(
				(present) =>
					longestCommonPrefixLength(present, decoded) >= siblingPrefixLength,
			)
		) {
			continue
		}
		const remainder = blankAbsenceSpans(input.content, decoded, calls)
		if (mentionsNeedle(remainder, { decoded, rawInner })) continue
		if (
			input.otherContents.some((content) =>
				mentionsNeedle(content, { decoded, rawInner }),
			)
		) {
			continue
		}
		seen.add(decoded)
		matches.push({
			file: input.relativePath,
			line: call.line,
			needle: decoded,
		})
	}
	return matches
}

async function collectScannedFiles(
	cwd: string,
	relativeRoot = '',
): Promise<Array<string>> {
	const matches: Array<string> = []
	const root = path.join(cwd, relativeRoot)
	const stack = [root]
	while (stack.length > 0) {
		const current = stack.pop()
		if (!current) continue
		let entries
		try {
			entries = await readdir(current, { withFileTypes: true })
		} catch (error) {
			if (
				error instanceof Error &&
				'code' in error &&
				error.code === 'ENOENT'
			) {
				continue
			}
			throw error
		}
		for (const entry of entries) {
			const absolutePath = path.join(current, entry.name)
			const relativePath = path
				.relative(cwd, absolutePath)
				.replaceAll('\\', '/')
			if (entry.isDirectory()) {
				if (skipDirectoryNames.has(entry.name)) continue
				if (
					skipDirectoryPrefixes.some((prefix) =>
						`${relativePath}/`.startsWith(prefix),
					)
				) {
					continue
				}
				stack.push(absolutePath)
				continue
			}
			if (!entry.isFile() || !scannedFilePattern.test(entry.name)) continue
			matches.push(relativePath)
		}
	}
	return matches
}

export async function listTautologicalAbsencePaths(
	cwd: string = process.cwd(),
): Promise<Array<string>> {
	return [...new Set(await collectScannedFiles(cwd))].sort()
}

export async function checkTautologicalAbsence(
	cwd: string = process.cwd(),
): Promise<Array<TautologicalAbsenceMatch>> {
	const relativePaths = await listTautologicalAbsencePaths(cwd)
	const contents = new Map<string, string>()
	for (const relativePath of relativePaths) {
		contents.set(
			relativePath,
			await readFile(path.join(cwd, relativePath), 'utf8'),
		)
	}
	const matches: Array<TautologicalAbsenceMatch> = []
	for (const relativePath of relativePaths) {
		const content = contents.get(relativePath)
		if (!content) continue
		matches.push(
			...findTautologicalAbsenceMatches({
				relativePath,
				content,
				otherContents: relativePaths
					.filter((candidate) => candidate !== relativePath)
					.map((candidate) => contents.get(candidate) ?? ''),
			}),
		)
	}
	return matches
}

function formatMatches(matches: ReadonlyArray<TautologicalAbsenceMatch>) {
	return matches
		.map(
			(match) =>
				`${match.file}:${String(match.line)}: not.toContain(${JSON.stringify(match.needle)})`,
		)
		.join('\n')
}

export async function main(cwd: string = process.cwd()): Promise<void> {
	const matches = await checkTautologicalAbsence(cwd)
	if (matches.length === 0) {
		console.log('Tautological-absence check passed.')
		return
	}
	console.error(
		[
			`Tautological-absence check failed (${String(matches.length)} issue(s)).`,
			'Do not keep a lone not.toContain of copy that no longer exists in the repo.',
			'Fine while deleting; drop the assertion before commit. Keep absence checks that flip state or still appear on another path.',
			'See docs/contributing/testing-principles.md.',
			'',
			formatMatches(matches),
		].join('\n'),
	)
	process.exitCode = 1
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
