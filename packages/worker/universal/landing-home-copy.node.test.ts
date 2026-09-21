import { expect, test } from 'vitest'
import {
	landingCompareCaption,
	landingCompareWithItems,
	landingCompareWithoutItems,
	landingHeroHeadline,
	landingHeroHeadlineEmphasis,
	landingHeroLead,
	landingHeroPrimaryCta,
	landingHeroSecondaryCta,
	landingHeroSubhead,
	landingHeroSubheadEmphasis,
	landingHomePrimitives,
	landingInviteGuestLead,
	landingInviteHeading,
	landingInviteHeadingEmphasis,
	landingHomeUiCopyBlob,
	landingPrimitivesMoreLink,
	landingVsHeading,
	landingVsItems,
} from './landing-home-copy.ts'

test('locked homepage copy names the six primitives', () => {
	expect(landingHomePrimitives.map((item) => item.word)).toEqual([
		'memory',
		'secrets',
		'packages',
		'triggers',
		'integrations',
		'apps',
	])
	expect(
		landingHomePrimitives.find((item) => item.id === 'triggers')?.body,
	).toBe(
		'Subscriptions, emails, webhooks, and schedules that wake packages you own — no chat left open.',
	)
	expect(landingVsItems).toHaveLength(3)
	expect(landingCompareWithoutItems).toHaveLength(3)
	expect(landingCompareWithItems).toHaveLength(3)
	const withoutTriggersBody = landingHomeUiCopyBlob().replace(
		'Subscriptions, emails, webhooks, and schedules that wake packages you own — no chat left open.',
		'',
	)
	expect(withoutTriggersBody).not.toMatch(/\u2014|—/)
	expect(landingHeroHeadline).toBe(
		'You shouldn\u2019t have to start over in every agent.',
	)
	expect(landingHeroHeadline.endsWith(landingHeroHeadlineEmphasis)).toBe(true)
	expect(landingHeroHeadlineEmphasis).toBe('every agent.')
	expect(landingHeroSubhead).toBe(
		'Kody is the software platform your agents share',
	)
	expect(landingHeroSubhead.includes(landingHeroSubheadEmphasis)).toBe(true)
	expect(landingHeroSubheadEmphasis).toBe('software platform')
	expect(landingHeroLead.includes('Cursor')).toBe(true)
	expect(landingHeroPrimaryCta).toContain('Connect')
	expect(landingHeroSecondaryCta).toContain('how it works')
	expect(landingVsHeading.startsWith('Not another chat')).toBe(true)
	expect(landingCompareCaption.startsWith('Ask once')).toBe(true)
	expect(landingPrimitivesMoreLink).toContain('What is Kody')
	expect(landingInviteHeading).toBe('Give your services a home')
	expect(landingInviteHeadingEmphasis).toBe('home')
	expect(landingInviteGuestLead).toBe(
		'Create a free account and connect a service you already use.',
	)
})
