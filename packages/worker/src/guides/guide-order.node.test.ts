import { expect, test } from 'vitest'
import { sortGuidesByAuthoredOrder } from './guide-order.ts'
import { guides as webGuides } from './catalog.ts'

test('sortGuidesByAuthoredOrder reproduces the web catalog order from an arbitrarily shuffled input', () => {
	const shuffled = [...webGuides].toSorted((a, b) =>
		b.slug.localeCompare(a.slug),
	)
	const sorted = sortGuidesByAuthoredOrder(shuffled)
	expect(sorted.map((guide) => guide.slug)).toEqual(
		webGuides.map((guide) => guide.slug),
	)
})

test('sortGuidesByAuthoredOrder throws when a guide is missing from guideOrder', () => {
	const guidesWithUnknownSlug = [
		...webGuides,
		{ ...webGuides[0]!, slug: 'not-in-guide-order' },
	]
	expect(() => sortGuidesByAuthoredOrder(guidesWithUnknownSlug)).toThrow(
		/guide-order\.ts is missing guideOrder entr(?:y|ies) for: not-in-guide-order/,
	)
})

test('sortGuidesByAuthoredOrder throws when guideOrder names a slug with no matching guide', () => {
	const guidesMissingOneEntry = webGuides.filter(
		(guide) => guide.slug !== 'values',
	)
	expect(() => sortGuidesByAuthoredOrder(guidesMissingOneEntry)).toThrow(
		/guide-order\.ts lists guideOrder entr(?:y|ies) with no matching guide: values/,
	)
})
