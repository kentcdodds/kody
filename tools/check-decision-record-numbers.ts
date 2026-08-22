import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { isExecutedDirectly } from './node-runtime.ts'

export const defaultDecisionsDir = path.join(
	'docs',
	'contributing',
	'decisions',
)
export const defaultDecisionIndexPath = path.join(
	defaultDecisionsDir,
	'index.md',
)

const decisionRecordFilenamePattern =
	/^(?<prefix>\d{4})-(?<slug>[a-z0-9]+(?:-[a-z0-9]+)*)\.md$/
const decisionHeadingPrefixPattern = /^#\s+(\d{4})\b/
const decisionIndexLinkPattern = /\(\.\/(\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*)\.md\)/g

export type DecisionRecordKind = 'primary' | 'lab'

export type DecisionRecordFile = {
	filename: string
	prefix: string
	slug: string
	kind: DecisionRecordKind
}

export type DecisionRecordNumberCheckResult = {
	ok: boolean
	errors: Array<string>
}

export function classifyDecisionRecordFilename(
	filename: string,
): DecisionRecordFile | null {
	if (filename === '0000-template.md' || filename === 'index.md') {
		return null
	}
	const match = decisionRecordFilenamePattern.exec(filename)
	if (!match?.groups) {
		return null
	}
	const { prefix, slug } = match.groups
	return {
		filename,
		prefix,
		slug,
		kind: slug.endsWith('-lab') ? 'lab' : 'primary',
	}
}

export function findDuplicatePrimaryPrefixes(
	records: ReadonlyArray<DecisionRecordFile>,
): Array<string> {
	const primaries = records.filter((record) => record.kind === 'primary')
	const filesByPrefix = new Map<string, Array<string>>()
	for (const record of primaries) {
		const files = filesByPrefix.get(record.prefix) ?? []
		files.push(record.filename)
		filesByPrefix.set(record.prefix, files)
	}
	return [...filesByPrefix.entries()]
		.filter(([, files]) => files.length > 1)
		.map(
			([prefix, files]) =>
				`Duplicate decision number ${prefix}: ${files.toSorted().join(', ')}. Renumber the later record; lab companions may share a number only as NNNN-*-lab.md.`,
		)
}

export function findOrphanLabCompanions(
	records: ReadonlyArray<DecisionRecordFile>,
): Array<string> {
	const primaryPrefixes = new Set(
		records
			.filter((record) => record.kind === 'primary')
			.map((record) => record.prefix),
	)
	return records
		.filter((record) => record.kind === 'lab')
		.filter((record) => !primaryPrefixes.has(record.prefix))
		.map(
			(record) =>
				`Lab companion ${record.filename} has no primary ${record.prefix}-*.md record.`,
		)
}

const openingFencePattern = /^[ \t]{0,3}(?<fence>`{3,}|~{3,})/
const closingFencePattern = /^[ \t]{0,3}(?<fence>`{3,}|~{3,})[ \t]*$/
const atxHeadingLinePattern = /^ {0,3}# /

type MarkdownFence = {
	character: string
	length: number
}

function parseFenceMarker(line: string, pattern: RegExp): MarkdownFence | null {
	const fence = pattern.exec(line)?.groups?.fence
	if (!fence) return null
	return {
		character: fence[0] ?? '',
		length: fence.length,
	}
}

export function findFirstMarkdownHeading(content: string): string | undefined {
	let openFence: MarkdownFence | null = null
	for (const line of content.split('\n')) {
		if (openFence) {
			const closingFence = parseFenceMarker(line, closingFencePattern)
			if (
				closingFence?.character === openFence.character &&
				closingFence.length >= openFence.length
			) {
				openFence = null
			}
			continue
		}
		const openingFence = parseFenceMarker(line, openingFencePattern)
		if (openingFence) {
			openFence = openingFence
			continue
		}
		if (atxHeadingLinePattern.test(line)) {
			return line.trim()
		}
	}
	return undefined
}

export function findHeadingPrefixMismatches(input: {
	filename: string
	prefix: string
	content: string
}): Array<string> {
	const firstHeading = findFirstMarkdownHeading(input.content)
	if (!firstHeading) {
		return [`${input.filename} is missing a top-level heading.`]
	}
	const headingPrefix = decisionHeadingPrefixPattern.exec(firstHeading)?.[1]
	if (headingPrefix !== input.prefix) {
		return [
			`${input.filename} heading number ${headingPrefix ?? '(none)'} does not match filename prefix ${input.prefix}.`,
		]
	}
	return []
}

export function findIndexPrimaryNumberCollisions(
	indexContent: string,
): Array<string> {
	const primaryLinksByPrefix = new Map<string, Set<string>>()
	for (const match of indexContent.matchAll(decisionIndexLinkPattern)) {
		const basename = match[1]
		if (!basename) continue
		const record = classifyDecisionRecordFilename(`${basename}.md`)
		if (!record || record.kind === 'lab') continue
		const files = primaryLinksByPrefix.get(record.prefix) ?? new Set()
		files.add(record.filename)
		primaryLinksByPrefix.set(record.prefix, files)
	}
	return [...primaryLinksByPrefix.entries()]
		.filter(([, files]) => files.size > 1)
		.map(
			([prefix, files]) =>
				`docs/contributing/decisions/index.md links two primary records as ${prefix}: ${[...files].toSorted().join(', ')}.`,
		)
}

export async function checkDecisionRecordNumbers(
	cwd: string = process.cwd(),
	decisionsDir: string = defaultDecisionsDir,
	indexPath: string = defaultDecisionIndexPath,
): Promise<DecisionRecordNumberCheckResult> {
	const decisionsRoot = path.join(cwd, decisionsDir)
	const entries = await readdir(decisionsRoot, { withFileTypes: true })
	const errors: Array<string> = []
	const records: Array<DecisionRecordFile> = []

	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith('.md')) continue
		if (entry.name === '0000-template.md' || entry.name === 'index.md') {
			continue
		}
		const record = classifyDecisionRecordFilename(entry.name)
		if (!record) {
			errors.push(
				`${path.join(decisionsDir, entry.name)} is not NNNN-kebab-slug.md (or NNNN-kebab-slug-lab.md).`,
			)
			continue
		}
		records.push(record)
		const content = await readFile(path.join(decisionsRoot, entry.name), 'utf8')
		errors.push(
			...findHeadingPrefixMismatches({
				filename: path.join(decisionsDir, entry.name),
				prefix: record.prefix,
				content,
			}),
		)
	}

	errors.push(...findDuplicatePrimaryPrefixes(records))
	errors.push(...findOrphanLabCompanions(records))
	const indexContent = await readFile(path.join(cwd, indexPath), 'utf8')
	errors.push(...findIndexPrimaryNumberCollisions(indexContent))

	return {
		ok: errors.length === 0,
		errors,
	}
}

export async function main(cwd: string = process.cwd()): Promise<void> {
	const result = await checkDecisionRecordNumbers(cwd)
	if (result.ok) {
		console.log('Decision-record number check passed.')
		return
	}
	console.error(
		[
			`Decision-record number check failed (${String(result.errors.length)} issue(s)).`,
			'Each steering record needs a unique NNNN. Lab notes may share that number only as NNNN-*-lab.md.',
			'See docs/contributing/decisions/index.md.',
			'',
			...result.errors,
		].join('\n'),
	)
	process.exitCode = 1
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
