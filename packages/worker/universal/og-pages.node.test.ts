import { expect, test } from 'vitest'
import { landingHeroHeadline, landingHeroLead } from './landing-home-copy.ts'
import { publicOgPages } from './og-pages.ts'

test('homepage OG image uses the share-card lockup', () => {
	expect(publicOgPages.home.imageTitle).toBe(
		"Don't start over\nwith every agent",
	)
	expect(publicOgPages.home.imageSubtitle).toBe(
		'The software platform your agents share',
	)
	expect(
		`${publicOgPages.home.imageTitle} ${publicOgPages.home.imageSubtitle}`,
	).not.toMatch(/\u2014|\u2013|—|–/)
	// Link previews still describe the live homepage hero. The image is the
	// shorter lockup that fits 1200×630.
	expect(publicOgPages.home.ogTitle).toBe(`${landingHeroHeadline} · Kody`)
	expect(publicOgPages.home.ogDescription).toBe(landingHeroLead)
})
