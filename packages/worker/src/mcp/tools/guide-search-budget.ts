import { docHref } from '#universal/docs-nav.ts'

export const guideContentsModeLine =
	'- Contents: oversized guide; open a heading with `{id}:guide#{slug}`'

export function guideSectionModeLine(slug: string) {
	return `- Section: \`${slug}\``
}

export function buildGuideDetailHeaderLines(input: {
	id: string
	description: string
	category: string
	slug: string
	provider?: string | null
	lastVerified?: string | null
}) {
	return [
		`# Guide — \`${input.id}\``,
		'',
		input.description,
		'',
		'## Summary',
		'',
		`- Entity: \`${input.id}:guide\``,
		`- Category: \`${input.category}\``,
		`- Web: \`${docHref(input.slug)}\``,
		...(input.provider ? [`- Provider: ${input.provider}`] : []),
		...(input.lastVerified
			? [`- Last verified: \`${input.lastVerified}\``]
			: []),
	]
}

/**
 * Characters left for the guide body, heading, or TOC after the search
 * entity header and mode line. Must stay in sync with
 * `tools/oxlint/guide-section-budget.js`.
 */
export function guideSearchBodyBudget(input: {
	id: string
	description: string
	category: string
	slug: string
	provider?: string | null
	lastVerified?: string | null
	section?: string
	maxChars: number
}) {
	const header = buildGuideDetailHeaderLines(input).join('\n')
	const mode = Math.max(
		guideContentsModeLine.length,
		guideSectionModeLine(input.section ?? 'section').length,
	)
	// header + "\n" + mode + "\n\n" + body
	return Math.max(0, input.maxChars - header.length - mode - 3)
}
