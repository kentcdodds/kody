/** Resolve file names in unified diffs, including Git-only sections. */

export type GitDiffHeaderPaths = {
	oldFileName: string
	newFileName: string
	isDelete?: boolean
	isNew?: boolean
}

export type UnifiedDiffSection = { text: string; header?: GitDiffHeaderPaths }

/** Split a diff into source sections so Git headers stay paired with their own patch. */
export function splitUnifiedDiffSections(patchText: string): UnifiedDiffSection[] {
	const lines = patchText.split(/\r?\n/)
	const starts: number[] = []
	let gitSection = false
	let hasHunk = false
	let hasDashes = false
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!
		if (line.startsWith('diff --git ')) {
			starts.push(index); gitSection = true; hasHunk = false; hasDashes = false; continue
		}
		if (line.startsWith('@@ ')) hasHunk = true
		if (line.startsWith('---') && (!gitSection || (hasHunk && !hasDashes))) {
			starts.push(index); gitSection = false; hasHunk = false; hasDashes = true
		} else if (gitSection && line.startsWith('---')) hasDashes = true
	}
	return starts.map((start, position) => {
		const end = starts[position + 1] ?? lines.length
		const text = lines.slice(start, end).join('\n')
		return { text, header: parseGitHeader(text) }
	})
}

export function parseGitDiffHeaders(patchText: string): GitDiffHeaderPaths[] {
	return splitUnifiedDiffSections(patchText).map((s) => s.header).filter((h): h is GitDiffHeaderPaths => h != null)
}

export function resolveUnifiedDiffFileNames(
	patch: { oldFileName?: string; newFileName?: string },
	gitHeader?: GitDiffHeaderPaths,
): { oldFileName: string | undefined; newFileName: string | undefined } {
	const oldFileName = presentDiffFileName(patch.oldFileName)
	const newFileName = presentDiffFileName(patch.newFileName)
	return {
		oldFileName: oldFileName ?? gitHeader?.oldFileName ?? (gitHeader?.isNew ? '/dev/null' : undefined),
		newFileName: newFileName ?? (gitHeader?.isDelete ? '/dev/null' : gitHeader?.newFileName),
	}
}

export function stripUnifiedDiffPath(fileName: string | undefined): string | null {
	if (!fileName || fileName === '/dev/null') return null
	const stripped = fileName.replace(/^[ab]\//, '')
	return stripped || null
}

function presentDiffFileName(name: string | undefined): string | undefined {
	if (name == null || name === '') return undefined
	return name.replace(/^[ab]\//, '') ? name : undefined
}

function parseGitHeader(text: string): GitDiffHeaderPaths | undefined {
	const line = text.split(/\r?\n/)[0]
	if (!line?.startsWith('diff --git ')) return undefined
	const rest = line.slice('diff --git '.length)
	const first = readGitPathToken(rest, 0)
	if (!first || rest[first.next] !== ' ') return undefined
	const second = readGitPathToken(rest, first.next + 1)
	if (!second || rest.slice(second.next).trim() !== '') return undefined
	const isDelete = /(?:^|\n)deleted file mode\s/.test(text)
	const isNew = /(?:^|\n)new file mode\s/.test(text)
	return { oldFileName: first.path, newFileName: second.path, ...(isDelete ? { isDelete: true } : {}), ...(isNew ? { isNew: true } : {}) }
}

function readGitPathToken(input: string, start: number): { path: string; next: number } | null {
	if (start >= input.length) return null
	if (input[start] !== '"') {
		let index = start
		while (index < input.length && input[index] !== ' ') index++
		return index === start ? null : { path: input.slice(start, index), next: index }
	}
	let index = start + 1
	let path = ''
	const decoder = new TextDecoder()
	while (index < input.length) {
		const char = input[index]
		if (char === '"') return { path, next: index + 1 }
		if (char === '\\' && index + 1 < input.length) {
			const escaped = input[index + 1]!
			if (escaped >= '0' && escaped <= '7') {
				const bytes: number[] = []
				while (input[index] === '\\' && /[0-7]/.test(input[index + 1] ?? '')) {
					const end = Math.min(index + 4, input.length)
					let cursor = index + 1
					while (cursor < end && /[0-7]/.test(input[cursor]!)) cursor++
					bytes.push(Number.parseInt(input.slice(index + 1, cursor), 8)); index = cursor
				}
				path += decoder.decode(new Uint8Array(bytes)); continue
			}
			path += ({ n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"' } as Record<string, string>)[escaped] ?? escaped
			index += 2; continue
		}
		path += char; index++
	}
	return null
}
