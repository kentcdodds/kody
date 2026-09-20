import { expect, test } from 'vitest'
import { landingHeroHeadline } from './landing-home-copy.ts'
import {
	landingHeroCarouselOmittedVideoIds,
	landingHeroChooserLabel,
	landingHeroChooserLabelEmphasis,
	presentLandingHeroVideos,
} from './landing-hero-copy.ts'

test('homepage carousel drops the retired hero thumbs and retitles leftover Stop Sweating copy', () => {
	const kept = {
		videoId: 'o5L5OprLhBg',
		title: 'Kody fixes a Stripe webhook after we renamed the domain',
	}
	const presented = presentLandingHeroVideos([
		{
			videoId: landingHeroCarouselOmittedVideoIds[0],
			title: 'Build in Cursor, then run it from Claude Code or ChatGPT',
		},
		{
			videoId: landingHeroCarouselOmittedVideoIds[1],
			title: 'Introducing Kody: Your Personal Software Factory',
		},
		kept,
		{
			videoId: 'OZKDO9Pzmo0',
			title: 'Stop Sweating Agent Switching',
		},
	])
	expect(presented.map((video) => video.videoId)).toEqual([
		kept.videoId,
		'OZKDO9Pzmo0',
	])
	expect(presented[0]?.title).toBe(kept.title)
	expect(presented[1]?.title).toBe(landingHeroHeadline)
	expect(JSON.stringify(presented)).not.toMatch(/stop sweating/i)
	expect(JSON.stringify(presented)).not.toMatch(/\u2014|—/)
	expect(landingHeroChooserLabel).toBe('Watch Some Demos')
	expect(
		landingHeroChooserLabel.endsWith(landingHeroChooserLabelEmphasis),
	).toBe(true)
	expect(landingHeroChooserLabelEmphasis).toBe('Demos')
})
