import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { parseGuideMarkdown } from '../../packages/worker/src/guides/parse-frontmatter.ts'
import {
	parseDocumentHeadings as parseRuntimeHeadings,
	slugifyDocumentHeading as slugifyRuntimeHeading,
} from '../../packages/worker/src/guides/document-sections.ts'
import { maxChars } from '../../packages/worker/src/mcp/tools/search-constants.ts'
import {
	buildGuideDetailHeaderLines as buildRuntimeHeaderLines,
	guideContentsModeLine as runtimeContentsModeLine,
	guideSearchBodyBudget as runtimeSearchBodyBudget,
	guideSectionModeLine as runtimeSectionModeLine,
} from '../../packages/worker/src/mcp/tools/guide-search-budget.ts'
// @ts-expect-error - the oxlint helper is plain JS with no type declarations.
import {
	buildGuideDetailHeaderLines,
	findOversizedDocumentSections,
	findOversizedOfficialGuideSections,
	guideContentsModeLine,
	guideSearchBodyBudget,
	guideSectionModeLine,
	isOfficialGuideCatalogFile,
	maxGuideSectionChars,
	parseDocumentHeadings,
	parseGuideLintMetadata,
	slugifyDocumentHeading,
	stripGuideFrontmatter,
} from './guide-section-budget.js'

const repoRoot = path.resolve(import.meta.dirname, '../..')

test('guide section budget matches search maxChars, header reserve, and heading parser', async () => {
	expect(maxGuideSectionChars).toBe(maxChars)
	expect(guideContentsModeLine).toBe(runtimeContentsModeLine)
	expect(guideSectionModeLine('repo.pushed')).toBe(
		runtimeSectionModeLine('repo.pushed'),
	)
	expect(slugifyDocumentHeading('`repo.pushed`')).toBe(
		slugifyRuntimeHeading('`repo.pushed`'),
	)

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
	).toEqual(parseRuntimeHeadings(nestedFence).map((heading) => heading.slug))
	expect(
		parseDocumentHeadings(nestedFence).some((heading) =>
			heading.title.includes('Nested info-string'),
		),
	).toBe(false)

	const raw = await readFile(
		path.join(repoRoot, 'docs/guides/package-subscriptions.md'),
		'utf8',
	)
	const parsed = parseGuideMarkdown('package-subscriptions', raw)
	const lintMeta = parseGuideLintMetadata(raw, 'package-subscriptions')
	expect(lintMeta).toMatchObject({
		id: parsed.id,
		description: parsed.summary,
		category: parsed.category,
		slug: parsed.slug,
	})
	expect(buildGuideDetailHeaderLines(lintMeta)).toEqual(
		buildRuntimeHeaderLines({
			id: parsed.id,
			description: parsed.summary,
			category: parsed.category,
			slug: parsed.slug,
			provider: parsed.provider,
			lastVerified: parsed.lastVerified,
		}),
	)
	expect(
		guideSearchBodyBudget({ ...lintMeta, section: 'repo.pushed' }),
	).toBeLessThan(maxChars)
	expect(guideSearchBodyBudget({ ...lintMeta, section: 'repo.pushed' })).toBe(
		runtimeSearchBodyBudget({
			id: parsed.id,
			description: parsed.summary,
			category: parsed.category,
			slug: parsed.slug,
			provider: parsed.provider,
			lastVerified: parsed.lastVerified,
			section: 'repo.pushed',
			maxChars,
		}),
	)

	expect(
		parseDocumentHeadings(parsed.body).map((heading) => heading.slug),
	).toEqual(parseRuntimeHeadings(parsed.body).map((heading) => heading.slug))

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

test('oversized official guide sections fail the header-aware budget and oxlint rule', async () => {
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
	const headerAwareLimit = guideSearchBodyBudget(
		parseGuideLintMetadata(fixture, 'oversized-fixture'),
		maxGuideSectionChars,
	)
	const justOverHeaderBudget = [
		'---',
		'id: header_budget_fixture',
		'title: Header budget fixture',
		'summary: A long enough summary to shrink the remaining body budget.',
		'category: platform',
		'---',
		'',
		'# Title',
		'',
		'## Almost',
		'',
		'y'.repeat(headerAwareLimit + 80),
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
			path.join(cwd, 'docs/guides/header-budget-fixture.md'),
			justOverHeaderBudget,
		)
		await writeFile(
			path.join(cwd, 'docs/guides/README.md'),
			'# Guides\n\nIndex pages are not official guide entities.\n',
		)
		const overflows = findOversizedOfficialGuideSections(cwd)
		expect(overflows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					file: 'docs/guides/oversized-fixture.md',
					slug: 'too-long',
					chars: expect.any(Number),
					limit: expect.any(Number),
				}),
				expect.objectContaining({
					file: 'docs/guides/header-budget-fixture.md',
					slug: 'almost',
				}),
			]),
		)
		const headerAware = overflows.find(
			(section) => section.file === 'docs/guides/header-budget-fixture.md',
		)
		expect(headerAware?.limit).toBeLessThan(maxGuideSectionChars)
		expect(headerAware?.chars).toBeLessThanOrEqual(maxGuideSectionChars)
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
