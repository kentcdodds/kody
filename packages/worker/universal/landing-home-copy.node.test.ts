import { expect, test } from 'vitest'
import {
	landingCompareCaption,
	landingCompareWithItems,
	landingCompareWithoutItems,
	landingHeroHeadline,
	landingHeroLead,
	landingHeroPrimaryCta,
	landingHeroSecondaryCta,
	landingHeroSubhead,
	landingHomePrimitives,
	landingHomeUiCopyBlob,
	landingPrimitivesMoreLink,
	landingVsHeading,
	landingVsItems,
} from './landing-home-copy.ts'

test('locked homepage copy names the five primitives and has no em dashes', () => {
	expect(landingHomePrimitives.map((item) => item.word)).toEqual([
		'memory',
		'secrets',
		'packages',
		'jobs',
		'integrations',
	])
	expect(landingVsItems).toHaveLength(3)
	expect(landingCompareWithoutItems).toHaveLength(3)
	expect(landingCompareWithItems).toHaveLength(3)
	expect(landingHomeUiCopyBlob()).not.toMatch(/\u2014|—/)
	expect(landingHeroHeadline.includes('start over')).toBe(true)
	expect(landingHeroSubhead.includes('software platform')).toBe(true)
	expect(landingHeroLead.includes('Cursor')).toBe(true)
	expect(landingHeroPrimaryCta).toContain('Connect')
	expect(landingHeroSecondaryCta).toContain('how it works')
	expect(landingVsHeading.startsWith('Not another chat')).toBe(true)
	expect(landingCompareCaption.startsWith('Ask once')).toBe(true)
	expect(landingPrimitivesMoreLink).toContain('What is Kody')
})
