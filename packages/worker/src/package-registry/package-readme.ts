const rootReadmeFileNamePattern = /^readme(?:\.[a-z0-9._-]+)?$/i
const preferredReadmeNames = [
	'readme.md',
	'readme.mdx',
	'readme.markdown',
	'readme.txt',
	'readme',
] as const

export type PackageReadmeSnippet = {
	path: string
	snippet: string
	truncated: boolean
}

export type PackageReadmeDetail = {
	path: string
	content: string
	truncated: boolean
}

function normalizeReadmeContent(content: string) {
	return content.replace(/\r\n/g, '\n').trim()
}

function stripLeadingTitleHeading(content: string) {
	return content.replace(/^#\s+[^\n]+\n+/, '').trim()
}

function collapseWhitespace(value: string) {
	return value.replace(/\s+/g, ' ').trim()
}

function toPlainTextSnippet(content: string) {
	return collapseWhitespace(
		content
			.replace(/```[\s\S]*?```/g, ' ')
			.replace(/`([^`]+)`/g, '$1')
			.replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
			.replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
			.replace(/^>\s?/gm, '')
			.replace(/^#{1,6}\s+/gm, '')
			.replace(/^[-*+]\s+/gm, '')
			.replace(/^\d+\.\s+/gm, ''),
	)
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

function sortReadmeCandidates(paths: Array<string>) {
	return [...paths].sort((left, right) => {
		const normalizedLeft = left.toLowerCase()
		const normalizedRight = right.toLowerCase()
		const leftIndex = preferredReadmeNames.indexOf(
			normalizedLeft as (typeof preferredReadmeNames)[number],
		)
		const rightIndex = preferredReadmeNames.indexOf(
			normalizedRight as (typeof preferredReadmeNames)[number],
		)
		const leftRank = leftIndex === -1 ? preferredReadmeNames.length : leftIndex
		const rightRank =
			rightIndex === -1 ? preferredReadmeNames.length : rightIndex
		if (leftRank !== rightRank) {
			return leftRank - rightRank
		}
		return normalizedLeft.localeCompare(normalizedRight)
	})
}

function findRootReadmeFile(files: Record<string, string>) {
	const matches = Object.keys(files).filter(
		(path) =>
			!path.includes('/') && rootReadmeFileNamePattern.test(path.trim().toLowerCase()),
	)
	const [firstMatch] = sortReadmeCandidates(matches)
	if (!firstMatch) {
		return null
	}
	const content = normalizeReadmeContent(files[firstMatch] ?? '')
	if (!content) {
		return null
	}
	return {
		path: firstMatch,
		content,
	}
}

export function buildPackageReadmeSnippet(input: {
	files: Record<string, string>
	maxChars?: number
}): PackageReadmeSnippet | null {
	const readme = findRootReadmeFile(input.files)
	if (!readme) {
		return null
	}
	const plainText = toPlainTextSnippet(stripLeadingTitleHeading(readme.content))
	if (!plainText) {
		return null
	}
	const trimmed = trimWithEllipsis(plainText, input.maxChars ?? 320)
	return {
		path: readme.path,
		snippet: trimmed.text,
		truncated: trimmed.truncated,
	}
}

export function buildPackageReadmeDetail(input: {
	files: Record<string, string>
	maxChars?: number
}): PackageReadmeDetail | null {
	const readme = findRootReadmeFile(input.files)
	if (!readme) {
		return null
	}
	const trimmed = trimWithEllipsis(readme.content, input.maxChars ?? 6_000)
	return {
		path: readme.path,
		content: trimmed.text,
		truncated: trimmed.truncated,
	}
}
