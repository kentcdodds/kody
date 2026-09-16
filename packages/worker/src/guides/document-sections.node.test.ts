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
