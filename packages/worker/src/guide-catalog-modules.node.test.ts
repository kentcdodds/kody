import { expect, test } from 'vitest'
import {
	guideMetadataList,
	importGuideCatalog,
} from './guide-catalog-modules.ts'
import { guides as webGuides } from './guides/catalog.ts'

test('guideMetadataList never carries a guide body', () => {
	expect(guideMetadataList.length).toBeGreaterThan(0)
	for (const guide of guideMetadataList) {
		expect(guide).not.toHaveProperty('body')
	}
})

test('guideMetadataList matches the web catalog on every non-body field', () => {
	expect(guideMetadataList.length).toBe(webGuides.length)
	const metadataById = new Map(
		guideMetadataList.map((guide) => [guide.id, guide]),
	)
	for (const webGuide of webGuides) {
		const { body, ...expectedMetadata } = webGuide
		expect(metadataById.get(webGuide.id)).toEqual(expectedMetadata)
	}
})

test('importGuideCatalog lazily resolves the full catalog with bodies matching the web catalog', async () => {
	const { guides } = await importGuideCatalog()
	expect(guides.length).toBe(webGuides.length)
	const generatedById = new Map(guides.map((guide) => [guide.id, guide]))
	for (const webGuide of webGuides) {
		expect(generatedById.get(webGuide.id)).toEqual(webGuide)
	}
})

test('guideMetadataList and importGuideCatalog preserve the exact authored order of the web catalog', async () => {
	// Order matters here, not just membership: `coding_guide_get`'s schema
	// description iterates `guideMetadataList` in this order, so a reordering
	// would silently change what the model sees even though every guide's
	// content still matched (asserted separately above).
	expect(guideMetadataList.map((guide) => guide.id)).toEqual(
		webGuides.map((guide) => guide.id),
	)

	const { guides } = await importGuideCatalog()
	expect(guides.map((guide) => guide.id)).toEqual(
		webGuides.map((guide) => guide.id),
	)
})

test('importGuideCatalog is memoized by the module system across repeated calls', async () => {
	const [first, second] = await Promise.all([
		importGuideCatalog(),
		importGuideCatalog(),
	])
	expect(first.guides).toBe(second.guides)
})
