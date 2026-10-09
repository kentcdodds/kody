import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
	findDocumentHeading,
	parseDocumentHeadings,
} from '../packages/worker/src/guides/document-sections.ts'

/**
 * GitHub heading permalinks (`href="#..."` on a rendered file).
 * Underscores stay. The guide slugger strips them, and `findDocumentHeading`
 * still resolves the GitHub form.
 */
const indexedPages = [
	'docs/contributing/architecture/data-storage.md',
	'docs/contributing/architecture/entitlements.md',
	'docs/contributing/architecture/usage-metering.md',
	'docs/contributing/disaster-recovery.md',
] as const

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const linkPattern = /^- \[(.*)\]\(#([a-z0-9_-]+)\)$/

function githubHeadingSlug(title: string) {
	return title
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(
			/[\s~`!@#$%^&*()\-+=[\]{}|\\;:"'\u2018\u2019\u201c\u201d\u2013\u2014<>,.?/]+/g,
			'-',
		)
		.replace(/-{2,}/g, '-')
		.replace(/^-+|-+$/g, '')
		.toLowerCase()
		.replace(/^(\d)/, '_$1')
}

function readPage(relativePath: string) {
	return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function levelTwoHeadings(markdown: string) {
	return parseDocumentHeadings(markdown).filter(
		(heading) => heading.level === 2 && heading.title !== 'Contents',
	)
}

function contentsLinks(markdown: string) {
	const lines = markdown.split('\n')
	const start = lines.indexOf('## Contents')
	if (start < 0) throw new Error('Missing ## Contents')
	let cursor = start + 1
	if (lines[cursor] === '') cursor += 1
	const links: Array<{ title: string; slug: string }> = []
	while (cursor < lines.length) {
		const line = lines[cursor] ?? ''
		if (line === '') break
		const match = linkPattern.exec(line)
		if (!match) throw new Error(`Contents line is not a heading link: ${line}`)
		const title = match[1]
		const slug = match[2]
		if (!title || !slug) throw new Error(`Unparsed contents link: ${line}`)
		links.push({ title, slug })
		cursor += 1
	}
	if (links.length === 0) throw new Error('## Contents has no links')
	return links
}

test('giant pages open with a contents list of every level-2 heading', () => {
	for (const relativePath of indexedPages) {
		const markdown = readPage(relativePath)
		const headings = parseDocumentHeadings(markdown)
		expect(headings[0]).toMatchObject({ level: 1 })
		expect(headings.find((heading) => heading.level === 2)?.title).toBe(
			'Contents',
		)

		const sections = levelTwoHeadings(markdown)
		const slugs = sections.map((heading) => githubHeadingSlug(heading.title))
		expect([...new Set(slugs)]).toEqual(slugs)

		const links = contentsLinks(markdown)
		expect(links.map((link) => ({ file: relativePath, ...link }))).toEqual(
			sections.map((heading) => ({
				file: relativePath,
				title: heading.title,
				slug: githubHeadingSlug(heading.title),
			})),
		)

		expect(
			links.map((link) => ({
				file: relativePath,
				slug: link.slug,
				resolved: findDocumentHeading(headings, link.slug)?.title ?? null,
			})),
		).toEqual(
			links.map((link) => ({
				file: relativePath,
				slug: link.slug,
				resolved: link.title,
			})),
		)
	}
})
