export const requiredPackageDocNames = ['README.md', 'AGENTS.md'] as const

export type RequiredPackageDocName = (typeof requiredPackageDocNames)[number]

export type RequiredPackageDoc = {
	path: string
	content: string
}

export type RequiredPackageDocsResult =
	| {
			ok: true
			message: string
	  }
	| {
			ok: false
			missing: Array<RequiredPackageDocName>
			message: string
	  }

function normalizeDocContent(content: string) {
	return content.replace(/\r\n/g, '\n').trim()
}

export function findRootPackageDoc(
	files: Record<string, string>,
	fileName: RequiredPackageDocName,
): RequiredPackageDoc | null {
	const target = fileName.toLowerCase()
	for (const [path, content] of Object.entries(files)) {
		if (path.includes('/')) continue
		if (path.toLowerCase() !== target) continue
		const normalized = normalizeDocContent(content)
		if (!normalized) return null
		return {
			path,
			content: normalized,
		}
	}
	return null
}

export function formatRequiredPackageDocsFailure(
	missing: Array<RequiredPackageDocName>,
) {
	const missingList = missing.join(' and ')
	return `Missing required package docs: ${missingList} ${missing.length === 1 ? 'is' : 'are'} missing or empty. Publish requires non-empty root README.md (human-focused: what it does, prerequisites, setup, done-when) and AGENTS.md (agent-focused: imports, smoke tests, edge cases). Existing published packages keep running; add both files before publishing a new version. See search({ entity: "package_authoring:guide" }).`
}

export function validateRequiredPackageDocs(
	files: Record<string, string>,
): RequiredPackageDocsResult {
	const missing = requiredPackageDocNames.filter(
		(fileName) => findRootPackageDoc(files, fileName) == null,
	)
	if (missing.length === 0) {
		return {
			ok: true,
			message: 'Validated root README.md and AGENTS.md.',
		}
	}
	return {
		ok: false,
		missing,
		message: formatRequiredPackageDocsFailure(missing),
	}
}

export function buildPackageAgentsDocs(input: {
	files: Record<string, string>
	maxChars?: number
}): {
	path: string
	content: string
	truncated: boolean
} | null {
	const agents = findRootPackageDoc(input.files, 'AGENTS.md')
	if (!agents) return null
	const maxChars = input.maxChars ?? 1_200
	if (agents.content.length <= maxChars) {
		return {
			path: agents.path,
			content: agents.content,
			truncated: false,
		}
	}
	return {
		path: agents.path,
		content: `${agents.content.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`,
		truncated: true,
	}
}
