import { expect, test } from 'vitest'
import {
	isGuidesStartHereSlug,
	isReservedGuideIndexSlug,
	guidesStartHereSlugs,
	reservedGuideIndexSlugs,
} from './guide-sections.ts'

test('guide section helpers recognize start-here and reserved index slugs', () => {
	expect([...guidesStartHereSlugs]).toEqual([
		'what-is-kody',
		'how-kody-works',
		'kody-factory',
		'quick-example',
	])
	expect(isGuidesStartHereSlug('what-is-kody')).toBe(true)
	expect(isGuidesStartHereSlug('oauth')).toBe(false)

	expect([...reservedGuideIndexSlugs]).toEqual(['connect'])
	expect(isReservedGuideIndexSlug('connect')).toBe(true)
	expect(isReservedGuideIndexSlug('github')).toBe(false)
})
