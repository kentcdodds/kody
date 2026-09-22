import { expect, test } from 'vitest'

import {
	findDocumentHeading,
	formatDocumentContents,
	parseDocumentHeadings,
	resolveMarkdownDocument,
	slugifyDocumentHeading,
} from './document-sections.ts'

const sample = `# Title

Intro paragraph.

## Manifest shape

Manifest details.

### Handler guidance

Handler details.

## \`repo.pushed\`

Repo payload.

\`\`\`md
## Fake heading in a fence
\`\`\`

## Filters on package-emitted topics

Filter rules.
`

test('document sections parse headings, skip fences, and resolve by slug or title', () => {
	expect(slugifyDocumentHeading('`repo.pushed`')).toBe('repo.pushed')
	expect(slugifyDocumentHeading('Filters on package-emitted topics')).toBe(
		'filters-on-package-emitted-topics',
	)

	const headings = parseDocumentHeadings(sample)
	expect(headings.map((heading) => heading.slug)).toEqual([
		'title',
		'manifest-shape',
		'handler-guidance',
		'repo.pushed',
		'filters-on-package-emitted-topics',
	])
	expect(
		headings.some((heading) => heading.title.includes('Fake heading')),
	).toBe(false)

	const repo = findDocumentHeading(headings, 'repo.pushed')
	expect(repo?.title).toBe('`repo.pushed`')
	expect(findDocumentHeading(headings, 'Repo.pushed')?.slug).toBe('repo.pushed')
	expect(
		findDocumentHeading(headings, 'Filters on package-emitted topics')?.slug,
	).toBe('filters-on-package-emitted-topics')
	expect(findDocumentHeading(headings, 'missing-section')).toBeNull()

	const full = resolveMarkdownDocument({
		markdown: sample,
		maxChars: 10_000,
		entityRef: 'guide:demo',
	})
	expect(full.mode).toBe('full')
	expect(full.markdown).toBe(sample)

	const toc = resolveMarkdownDocument({
		markdown: sample,
		maxChars: 80,
		entityRef: 'guide:demo',
	})
	expect(toc.mode).toBe('toc')
	expect(toc.markdown).toContain('## Contents')
	expect(toc.markdown).toContain('guide:demo#repo.pushed')
	expect(toc.markdown).not.toContain('Repo payload.')
	expect(toc.markdown).not.toContain('Fake heading in a fence')

	const section = resolveMarkdownDocument({
		markdown: sample,
		maxChars: 80,
		entityRef: 'guide:demo',
		section: 'repo.pushed',
	})
	expect(section.mode).toBe('section')
	expect(section.markdown).toContain('## `repo.pushed`')
	expect(section.markdown).toContain('Repo payload.')
	expect(section.markdown).not.toContain('Filter rules.')
	expect(section.selected?.slug).toBe('repo.pushed')

	expect(() =>
		resolveMarkdownDocument({
			markdown: sample,
			maxChars: 80,
			entityRef: 'guide:demo',
			section: 'not-a-heading',
		}),
	).toThrow(/Unknown section "not-a-heading" for guide:demo/)

	const contents = formatDocumentContents({
		headings,
		entityRef: 'guide:demo',
	})
	expect(contents).toContain(
		'  - `Handler guidance` — `guide:demo#handler-guidance`',
	)

	const oversizedSection = `${'#'.repeat(2)} Only heading\n\n${'x'.repeat(400)}`
	const truncated = resolveMarkdownDocument({
		markdown: oversizedSection,
		maxChars: 160,
		entityRef: 'guide:demo',
		section: 'only-heading',
	})
	expect(truncated.mode).toBe('section')
	expect(truncated.markdown).toContain('--- TRUNCATED ---')
	expect(truncated.markdown.length).toBeLessThanOrEqual(160)
})

test('document sections resolve line anchors before heading slugs', () => {
	const numbered = Array.from(
		{ length: 200 },
		(_, index) => `line ${String(index + 1)}`,
	).join('\n')
	const line = resolveMarkdownDocument({
		markdown: numbered,
		maxChars: 10_000,
		entityRef: 'guide:demo',
		section: 'L165',
	})
	expect(line.mode).toBe('lines')
	expect(line.lines).toMatchObject({
		requestedStartLine: 165,
		requestedEndLine: 165,
		startLine: 145,
		endLine: 185,
		totalLines: 200,
	})
	expect(line.markdown).toContain('165|line 165')
	expect(line.markdown).not.toContain('144|line 144')
	expect(line.selected).toBeNull()

	const range = resolveMarkdownDocument({
		markdown: numbered,
		maxChars: 10_000,
		entityRef: 'guide:demo',
		section: 'L165-L180',
	})
	expect(range.mode).toBe('lines')
	expect(range.lines).toMatchObject({
		requestedStartLine: 165,
		requestedEndLine: 180,
		startLine: 165,
		endLine: 180,
	})
	expect(range.markdown).not.toContain('164|line 164')
	expect(range.markdown).not.toContain('181|line 181')

	const titled = [
		'# Title',
		'',
		'## l165',
		'',
		'Heading body.',
		'',
		'## Other',
		'',
		'Other body.',
		...Array.from({ length: 200 }, (_, index) => `pad ${String(index + 1)}`),
	].join('\n')
	const heading = resolveMarkdownDocument({
		markdown: titled,
		maxChars: 10_000,
		entityRef: 'guide:demo',
		section: 'l165',
	})
	expect(heading.mode).toBe('section')
	expect(heading.selected?.slug).toBe('l165')
	expect(heading.markdown).toContain('Heading body.')
	expect(heading.markdown).not.toContain('Other body.')

	const lineWins = resolveMarkdownDocument({
		markdown: titled,
		maxChars: 10_000,
		entityRef: 'guide:demo',
		section: 'L165',
	})
	expect(lineWins.mode).toBe('lines')
	expect(lineWins.markdown).not.toContain('Heading body.')

	expect(() =>
		resolveMarkdownDocument({
			markdown: numbered,
			maxChars: 10_000,
			entityRef: 'guide:demo',
			section: 'L999',
		}),
	).toThrow(/Line 999 is past the end of guide:demo#L999/)
})

test('document sections keep info-string fence lines inside the open block', () => {
	const nestedFence = [
		'# Title',
		'',
		'```',
		'```js',
		'## Nested info-string fence',
		'```',
		'',
		'## Real',
		'',
	].join('\n')
	expect(
		parseDocumentHeadings(nestedFence).map((heading) => heading.slug),
	).toEqual(['title', 'real'])
})
