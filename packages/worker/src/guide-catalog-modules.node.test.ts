import { expect, test } from 'vitest'
import {
	guideMetadataList,
	importGuideCatalog,
} from './guide-catalog-modules.ts'
import { guides as webGuides } from './guides/catalog.ts'

test('guide catalog modules match the web catalog metadata, bodies, and order', async () => {
	expect(guideMetadataList.length).toBe(webGuides.length)
	expect(guideMetadataList.map((guide) => guide.id)).toEqual(
		webGuides.map((guide) => guide.id),
	)

	const metadataById = new Map(
		guideMetadataList.map((guide) => [guide.id, guide]),
	)
	for (const webGuide of webGuides) {
		const { body: _body, ...expectedMetadata } = webGuide
		expect(metadataById.get(webGuide.id)).toEqual(expectedMetadata)
	}

	const { guides } = await importGuideCatalog()
	expect(guides.map((guide) => guide.id)).toEqual(
		webGuides.map((guide) => guide.id),
	)
	const generatedById = new Map(guides.map((guide) => [guide.id, guide]))
	for (const webGuide of webGuides) {
		expect(generatedById.get(webGuide.id)).toEqual(webGuide)
	}

	const [first, second] = await Promise.all([
		importGuideCatalog(),
		importGuideCatalog(),
	])
	expect(first.guides).toBe(second.guides)
})
