import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { maxChars } from '../../packages/worker/src/mcp/tools/search-constants.ts'
import {
	parseDocumentHeadings as parseRuntimeHeadings,
	slugifyDocumentHeading as slugifyRuntimeHeading,
} from '../../packages/worker/src/guides/document-sections.ts'
// @ts-expect-error - the oxlint helper is plain JS with no type declarations.
import {
	findOversizedDocumentSections,
	findOversizedOfficialGuideSections,
	isOfficialGuideCatalogFile,
	maxGuideSectionChars,
	parseDocumentHeadings,
	slugifyDocumentHeading,
	stripGuideFrontmatter,
} from './guide-section-budget.js'

const repoRoot = path.resolve(import.meta.dirname, '../..')

test('guide section budget matches search maxChars and the runtime heading parser', async () => {
	expect(maxGuideSectionChars).toBe(maxChars)
	expect(slugifyDocumentHeading('`repo.pushed`')).toBe(
		slugifyRuntimeHeading('`repo.pushed`'),
	)

	const subscriptions = stripGuideFrontmatter(
		await readFile(
			path.join(repoRoot, 'docs/guides/package-subscriptions.md'),
			'utf8',
		),
	)
	expect(
		parseDocumentHeadings(subscriptions).map((heading) => heading.slug),
	).toEqual(parseRuntimeHeadings(subscriptions).map((heading) => heading.slug))

	expect(findOversizedOfficialGuideSections(repoRoot)).toEqual([])
	expect(
		isOfficialGuideCatalogFile(
			path.join(repoRoot, 'packages/worker/src/guides/catalog.ts'),
			repoRoot,
		),
	).toBe(true)
	expect(
		isOfficialGuideCatalogFile('docs/guides/package-subscriptions.md'),
	).toBe(false)
})

test('oversized official guide sections fail the budget helper and oxlint rule', async () => {
	const fixture = [
		'---',
		'id: oversized_fixture',
		'title: Oversized fixture',
		'summary: Fixture',
		'category: platform',
		'---',
		'',
		'# Title',
		'',
		'## Fits',
		'',
		'Short.',
		'',
		'## Too long',
		'',
		'x'.repeat(maxGuideSectionChars + 1),
		'',
	].join('\n')

	expect(stripGuideFrontmatter(fixture).startsWith('# Title')).toBe(true)
	expect(
		findOversizedDocumentSections(stripGuideFrontmatter(fixture)).map(
			(section) => section.slug,
		),
	).toEqual(['too-long'])

	const cwd = await mkdtemp(path.join(os.tmpdir(), 'guide-section-budget-'))
	try {
		await mkdir(path.join(cwd, 'docs/guides'), { recursive: true })
		await writeFile(path.join(cwd, 'docs/guides/oversized-fixture.md'), fixture)
		await writeFile(
			path.join(cwd, 'docs/guides/README.md'),
			'# Guides\n\nIndex pages are not official guide entities.\n',
		)
		expect(findOversizedOfficialGuideSections(cwd)).toEqual([
			expect.objectContaining({
				file: 'docs/guides/oversized-fixture.md',
				slug: 'too-long',
				chars: expect.any(Number),
				limit: maxGuideSectionChars,
			}),
		])
	} finally {
		await rm(cwd, { recursive: true, force: true })
	}

	const result = spawnSync(
		path.join(repoRoot, 'node_modules', 'oxlint', 'bin', 'oxlint'),
		['packages/worker/src/guides/catalog.ts'],
		{ cwd: repoRoot, encoding: 'utf8' },
	)
	expect(result.stdout + result.stderr).not.toContain(
		'no-oversized-guide-section',
	)
	expect(result.status).toBe(0)
})
