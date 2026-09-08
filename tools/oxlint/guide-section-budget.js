import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { cwd as processCwd } from 'node:process'

/**
 * Must match `maxChars` in
 * `packages/worker/src/mcp/tools/search-constants.ts`.
 */
export const maxGuideSectionChars = 6_000 * 4

const headingLinePattern = /^(#{1,6})\s+(.+?)\s*$/
const fencedBlockPattern = /^(`{3,}|~{3,})/
const officialGuideFilePattern = /\.md$/
const skipGuideNames = new Set(['README.md'])

export function stripGuideFrontmatter(raw) {
	const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
	if (!normalized.startsWith('---\n')) return normalized
	const endIndex = normalized.indexOf('\n---\n', 4)
	if (endIndex === -1) return normalized
	return normalized.slice(endIndex + '\n---\n'.length).replace(/^\n/, '')
}

export function slugifyDocumentHeading(title) {
	return normalizeHeadingKey(title)
		.replace(/[^\p{L}\p{N}._-]+/gu, '-')
		.replace(/-+/g, '-')
		.replace(/^-+|-+$/g, '')
}

export function parseDocumentHeadings(markdown) {
	const lines = markdown.split('\n')
	const parsed = []
	let fence = null

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? ''
		const fenceMatch = line.match(fencedBlockPattern)
		if (fenceMatch) {
			const marker = fenceMatch[1] ?? ''
			if (fence == null) {
				fence = marker
			} else if (marker[0] === fence[0] && marker.length >= fence.length) {
				fence = null
			}
			continue
		}
		if (fence != null) continue

		const headingMatch = line.match(headingLinePattern)
		if (!headingMatch) continue
		const marks = headingMatch[1] ?? ''
		const rawTitle = headingMatch[2] ?? ''
		parsed.push({
			level: marks.length,
			title: rawTitle.replace(/\s+#+\s*$/, '').trim(),
			start: index,
		})
	}

	const usedSlugs = new Map()
	return parsed.map((heading, index) => {
		const nextSameOrHigher = parsed
			.slice(index + 1)
			.find((candidate) => candidate.level <= heading.level)
		const baseSlug = slugifyDocumentHeading(heading.title) || 'section'
		const seen = usedSlugs.get(baseSlug) ?? 0
		usedSlugs.set(baseSlug, seen + 1)
		return {
			...heading,
			slug: seen === 0 ? baseSlug : `${baseSlug}-${String(seen + 1)}`,
			end: nextSameOrHigher?.start ?? lines.length,
		}
	})
}

export function findOversizedDocumentSections(
	markdown,
	limit = maxGuideSectionChars,
) {
	const headings = parseDocumentHeadings(markdown)
	const lines = markdown.split('\n')
	const requestable = headings.filter((heading) => heading.level >= 2)
	const toCheck = requestable.length > 0 ? requestable : headings
	if (toCheck.length === 0 && markdown.length > limit) {
		return [
			{
				slug: '(document)',
				title: '(document)',
				level: 0,
				chars: markdown.length,
				limit,
			},
		]
	}
	return toCheck
		.map((heading) => {
			const chars = lines.slice(heading.start, heading.end).join('\n').length
			return {
				slug: heading.slug,
				title: heading.title,
				level: heading.level,
				chars,
				limit,
			}
		})
		.filter((section) => section.chars > section.limit)
}

export function findOversizedOfficialGuideSections(
	root = processCwd(),
	limit = maxGuideSectionChars,
) {
	const guidesDir = path.join(root, 'docs/guides')
	const overflows = []
	for (const file of listOfficialGuideFiles(guidesDir)) {
		const raw = readFileSync(file, 'utf8')
		const body = stripGuideFrontmatter(raw)
		const relative = path.relative(root, file).replaceAll('\\', '/')
		for (const section of findOversizedDocumentSections(body, limit)) {
			overflows.push({ file: relative, ...section })
		}
	}
	return overflows
}

export function isOfficialGuideCatalogFile(filename, cwd = processCwd()) {
	const relative =
		typeof filename === 'string' && path.isAbsolute(filename)
			? path.relative(cwd, filename).replaceAll('\\', '/')
			: String(filename ?? '').replaceAll('\\', '/')
	return relative === 'packages/worker/src/guides/catalog.ts'
}

function listOfficialGuideFiles(dir) {
	const files = []
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const next = path.join(dir, entry.name)
		if (entry.isDirectory()) {
			files.push(...listOfficialGuideFiles(next))
			continue
		}
		if (!officialGuideFilePattern.test(entry.name)) continue
		if (skipGuideNames.has(entry.name)) continue
		files.push(next)
	}
	return files
}

function normalizeHeadingKey(value) {
	return value
		.replace(/[`*_~]/g, '')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase()
}
