import {
	type RepoSearchFileMatch,
	type RepoSearchMatch,
	type RepoSearchMode,
	type RepoSearchOutputMode,
	type RepoSessionSearchResult,
} from './types.ts'

const defaultRepoSearchLimit = 50
const maxRepoSearchBytes = 200_000
const maxRepoSearchRegexLength = 512
const obviousNestedQuantifierPattern =
	/\((?:[^()\\]|\\.)*[+*{][^)]*\)(?:[+*]|\{\d+(?:,\d*)?\})/

function normalizeSearchLimit(limit: number | undefined) {
	if (!Number.isFinite(limit)) return defaultRepoSearchLimit
	return Math.min(Math.max(Math.trunc(limit as number), 1), 200)
}

function escapeRegex(source: string) {
	return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function assertSafeRepoSearchRegex(pattern: string) {
	if (pattern.length > maxRepoSearchRegexLength) {
		throw new Error(
			`repo_search regex patterns must be ${maxRepoSearchRegexLength} characters or fewer.`,
		)
	}
	if (obviousNestedQuantifierPattern.test(pattern)) {
		throw new Error(
			'repo_search rejected an unsafe regex pattern with nested quantifiers.',
		)
	}
}

function normalizeSearchQuery(input: {
	pattern: string
	mode?: RepoSearchMode
}) {
	const pattern = input.pattern.trim()
	if (!pattern) {
		throw new Error('repo_search requires a non-empty pattern.')
	}
	return {
		query: pattern,
		regex: input.mode === 'regex',
	}
}

function searchInText(input: {
	content: string
	query: string
	regex: boolean
	caseSensitive: boolean
	contextBefore: number
	contextAfter: number
	maxMatches: number
}) {
	const inputTruncated = input.content.length > maxRepoSearchBytes
	// Bound regex work so a single pathological search cannot monopolize the DO.
	const source = inputTruncated
		? input.content.slice(0, maxRepoSearchBytes)
		: input.content
	const flags = input.caseSensitive ? 'g' : 'gi'
	const pattern = input.regex ? input.query : escapeRegex(input.query)
	if (input.regex) {
		assertSafeRepoSearchRegex(pattern)
	}
	let matcher: RegExp
	try {
		matcher = new RegExp(pattern, flags)
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: 'Unknown regex compilation error.'
		throw new Error(`repo_search received an invalid regex: ${message}`)
	}
	const lines = source.split('\n')
	const lineOffsets: number[] = []
	let offset = 0
	for (const line of lines) {
		lineOffsets.push(offset)
		offset += line.length + 1
	}
	const matches: Array<{
		line: number
		column: number
		match: string
		lineText: string
		beforeLines?: string[]
		afterLines?: string[]
	}> = []
	let truncated = false
	for (const match of source.matchAll(matcher)) {
		if (matches.length >= input.maxMatches) {
			truncated = true
			break
		}
		const index = match.index ?? 0
		let lineIndex = 0
		for (let candidate = 0; candidate < lineOffsets.length; candidate += 1) {
			const candidateOffset = lineOffsets[candidate]
			if (candidateOffset === undefined) break
			if (candidateOffset > index) break
			lineIndex = candidate
		}
		const lineStart = lineOffsets[lineIndex] ?? 0
		const column = index - lineStart + 1
		const lineText = lines[lineIndex] ?? ''
		const beforeStart = Math.max(0, lineIndex - input.contextBefore)
		const afterEnd = Math.min(lines.length, lineIndex + input.contextAfter + 1)
		matches.push({
			line: lineIndex + 1,
			column,
			match: match[0] ?? '',
			lineText,
			beforeLines: lines.slice(beforeStart, lineIndex),
			afterLines: lines.slice(lineIndex + 1, afterEnd),
		})
	}
	return {
		matches,
		truncated: truncated || inputTruncated,
	}
}

export async function searchRepoWorkspace(input: {
	workspace: {
		glob(pattern: string): Promise<Array<{ path: string; type: string }>>
		readFile(path: string): Promise<string | null>
	}
	root: string
	pattern: string
	mode?: RepoSearchMode
	glob?: string | null
	caseSensitive?: boolean
	before?: number
	after?: number
	limit?: number
	outputMode?: RepoSearchOutputMode
	toExternalPath(path: string): string
}): Promise<RepoSessionSearchResult> {
	const search = normalizeSearchQuery({
		pattern: input.pattern,
		mode: input.mode,
	})
	const globPattern =
		input.glob?.trim() ||
		`${input.root.replace(/\/+$/, '')}/**/*.{ts,tsx,js,jsx,json,md,css}`
	const files = await input.workspace.glob(globPattern)
	const matchMap = new Map<string, RepoSearchFileMatch>()
	const outputMode = input.outputMode ?? 'content'
	let remaining = normalizeSearchLimit(input.limit)
	let totalMatches = 0
	let truncated = false
	for (const file of files) {
		if (remaining <= 0) break
		if (file.type !== 'file') continue
		const content = await input.workspace.readFile(file.path)
		if (content == null) continue
		const result = searchInText({
			content,
			query: search.query,
			regex: search.regex,
			caseSensitive: input.caseSensitive ?? false,
			contextBefore: input.before ?? 0,
			contextAfter: input.after ?? 0,
			maxMatches: remaining,
		})
		const matches = result.matches
		if (matches.length === 0) continue
		totalMatches += matches.length
		remaining = Math.max(0, remaining - matches.length)
		truncated ||= result.truncated || remaining === 0
		matchMap.set(file.path, {
			path: input.toExternalPath(file.path),
			matches:
				outputMode === 'files'
					? []
					: matches.map<RepoSearchMatch>((match) => ({
							line: match.line,
							column: match.column,
							match: match.match,
							lineText: match.lineText,
							beforeLines: match.beforeLines ?? [],
							afterLines: match.afterLines ?? [],
						})),
		})
	}
	const filesWithMatches = [...matchMap.values()].sort((left, right) =>
		left.path.localeCompare(right.path),
	)
	return {
		files: filesWithMatches,
		totalFiles: filesWithMatches.length,
		totalMatches,
		outputMode,
		truncated,
	}
}
