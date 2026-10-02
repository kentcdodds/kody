/**
 * Path resolution for unified diffs applied by repo sessions.
 *
 * jsdiff's `parsePatch` fills `oldFileName` / `newFileName` from `---` / `+++`
 * headers. Agent-generated git patches often only have `diff --git a/<path>
 * b/<path>` (no dashes), or have empty `---` / `+++` lines that overwrite the
 * git-header names with blanks. Resolve missing names from `diff --git`
 * headers in document order so `repoApplyPatch` can apply those patches.
 */

export type GitDiffHeaderPaths = {
	oldFileName: string
	newFileName: string
}

/**
 * Parse every `diff --git <old> <new>` header from a unified-diff document.
 * Supports unquoted paths and git C-style quoted paths (spaces, escapes).
 */
export function parseGitDiffHeaders(
	patchText: string,
): Array<GitDiffHeaderPaths> {
	const headers: Array<GitDiffHeaderPaths> = []
	for (const line of patchText.split(/\r?\n/)) {
		if (!line.startsWith('diff --git ')) continue
		const rest = line.slice('diff --git '.length)
		const first = readGitPathToken(rest, 0)
		if (!first) continue
		if (rest[first.next] !== ' ') continue
		const second = readGitPathToken(rest, first.next + 1)
		if (!second) continue
		if (rest.slice(second.next).trim() !== '') continue
		headers.push({
			oldFileName: first.path,
			newFileName: second.path,
		})
	}
	return headers
}

/**
 * Prefer parsePatch file names when present and usable; fill gaps from the
 * matching `diff --git` header (same index in document order).
 */
export function resolveUnifiedDiffFileNames(
	patch: { oldFileName?: string; newFileName?: string },
	gitHeader?: GitDiffHeaderPaths,
): { oldFileName: string | undefined; newFileName: string | undefined } {
	const fromPatchOld = presentDiffFileName(patch.oldFileName)
	const fromPatchNew = presentDiffFileName(patch.newFileName)
	if (fromPatchOld && fromPatchNew) {
		return { oldFileName: fromPatchOld, newFileName: fromPatchNew }
	}
	if (!gitHeader) {
		return { oldFileName: fromPatchOld, newFileName: fromPatchNew }
	}
	return {
		oldFileName: fromPatchOld ?? gitHeader.oldFileName,
		newFileName: fromPatchNew ?? gitHeader.newFileName,
	}
}

/**
 * Strip a leading `a/` or `b/` prefix. `/dev/null` and empty names become
 * null so callers can treat them as "no path on this side."
 */
export function stripUnifiedDiffPath(
	fileName: string | undefined,
): string | null {
	if (!fileName || fileName === '/dev/null') return null
	const stripped = fileName.replace(/^[ab]\//, '')
	return stripped || null
}

function presentDiffFileName(name: string | undefined): string | undefined {
	if (name == null || name === '') return undefined
	if (name === '/dev/null') return name
	const stripped = name.replace(/^[ab]\//, '')
	return stripped ? name : undefined
}

function readGitPathToken(
	input: string,
	start: number,
): { path: string; next: number } | null {
	if (start >= input.length) return null
	if (input[start] === '"') {
		let index = start + 1
		let path = ''
		while (index < input.length) {
			const char = input[index]
			if (char === '"') {
				return { path, next: index + 1 }
			}
			if (char === '\\' && index + 1 < input.length) {
				const escaped = input[index + 1]!
				switch (escaped) {
					case 'n':
						path += '\n'
						break
					case 't':
						path += '\t'
						break
					case 'r':
						path += '\r'
						break
					case '\\':
						path += '\\'
						break
					case '"':
						path += '"'
						break
					default:
						path += escaped
						break
				}
				index += 2
				continue
			}
			path += char
			index += 1
		}
		return null
	}
	let index = start
	while (index < input.length && input[index] !== ' ') {
		index += 1
	}
	if (index === start) return null
	return { path: input.slice(start, index), next: index }
}
