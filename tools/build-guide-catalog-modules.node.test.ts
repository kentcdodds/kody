import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { ensureGuideCatalogModules } from './build-guide-catalog-modules.ts'
import {
	guideMetadataList,
	importGuideCatalog,
} from '#worker/guide-catalog-modules.ts'
import { guides as webGuides } from '#worker/guides/catalog.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const stampPath = path.join(
	repoRoot,
	'packages/worker/src/generated/guide-catalog.stamp.json',
)

test('ensureGuideCatalogModules generates metadata and a full catalog matching the web catalog', async () => {
	await ensureGuideCatalogModules()

	expect(guideMetadataList.length).toBe(webGuides.length)
	const metadataById = new Map(
		guideMetadataList.map((guide) => [guide.id, guide]),
	)

	const { guides } = await importGuideCatalog()
	expect(guides.length).toBe(webGuides.length)
	const fullById = new Map(guides.map((guide) => [guide.id, guide]))

	for (const webGuide of webGuides) {
		const { body, ...expectedMetadata } = webGuide
		expect(metadataById.get(webGuide.id)).toEqual(expectedMetadata)
		expect(fullById.get(webGuide.id)).toEqual(webGuide)
	}

	// Order matters, not just membership: the web catalog has intentional
	// authored platform ordering followed by alphabetical provider ordering
	// (see `#worker/guides/guide-order.ts`), and `coding_guide_get`'s schema
	// description follows `guideMetadataList` order directly.
	expect(guideMetadataList.map((guide) => guide.id)).toEqual(
		webGuides.map((guide) => guide.id),
	)
	expect(guides.map((guide) => guide.id)).toEqual(
		webGuides.map((guide) => guide.id),
	)
})

test('ensureGuideCatalogModules is idempotent: a warm re-run does not rewrite the stamp', async () => {
	await ensureGuideCatalogModules()
	const before = await stat(stampPath)
	const beforeContent = await readFile(stampPath, 'utf8')

	await ensureGuideCatalogModules()

	const after = await stat(stampPath)
	const afterContent = await readFile(stampPath, 'utf8')
	expect(afterContent).toBe(beforeContent)
	expect(after.mtimeMs).toBe(before.mtimeMs)
})
