export const requiredPackageDocPaths = ['README.md', 'AGENTS.md'] as const

export type RequiredPackageDocPath = (typeof requiredPackageDocPaths)[number]

export type PackageDocDetail = {
	path: RequiredPackageDocPath
	content: string
	truncated: boolean
}

function normalizePackageDocContent(content: string) {
	return content.replace(/\r\n/g, '\n').trim()
}

function trimWithEllipsis(value: string, maxChars: number) {
	if (value.length <= maxChars) {
		return {
			text: value,
			truncated: false,
		}
	}
	const trimmed = value.slice(0, Math.max(0, maxChars - 1)).trimEnd()
	return {
		text: `${trimmed}…`,
		truncated: true,
	}
}

export function findRequiredPackageDoc(
	files: Record<string, string>,
	path: RequiredPackageDocPath,
) {
	const content = normalizePackageDocContent(files[path] ?? '')
	if (!content) return null
	return {
		path,
		content,
	}
}

export function listMissingRequiredPackageDocs(files: Record<string, string>) {
	return requiredPackageDocPaths.filter(
		(path) => findRequiredPackageDoc(files, path) == null,
	)
}

export function formatRequiredPackageDocsFailure(
	missing: ReadonlyArray<RequiredPackageDocPath>,
) {
	return `Publish requires a non-empty root README.md (human setup: what it does, prerequisites, setup, done-when) and a non-empty root AGENTS.md (agent notes: imports, smoke tests, edge cases). Missing or empty: ${missing
		.map((path) => `"${path}"`)
		.join(', ')}.`
}

export function validateRequiredPackageDocs(files: Record<string, string>) {
	const missing = listMissingRequiredPackageDocs(files)
	if (missing.length === 0) {
		return {
			ok: true as const,
			message: 'Found non-empty root README.md and AGENTS.md.',
		}
	}
	return {
		ok: false as const,
		message: formatRequiredPackageDocsFailure(missing),
	}
}

export function buildPackageAgentsDetail(input: {
	files: Record<string, string>
	maxChars?: number
}): PackageDocDetail | null {
	const agents = findRequiredPackageDoc(input.files, 'AGENTS.md')
	if (!agents) return null
	const trimmed = trimWithEllipsis(agents.content, input.maxChars ?? 1_200)
	return {
		path: agents.path,
		content: trimmed.text,
		truncated: trimmed.truncated,
	}
}
