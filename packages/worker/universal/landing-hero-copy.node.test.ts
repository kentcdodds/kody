import { expect, test } from 'vitest'
import { landingHeroHeadline } from './landing-home-copy.ts'
import { presentLandingHeroVideos } from './landing-hero-copy.ts'

test('homepage carousel keeps playlist order and retitles leftover Stop Sweating copy', () => {
	const first = {
		videoId: 'iGMkgjXc8Ho',
		title: 'Build in Cursor, then run it from Claude Code or ChatGPT',
	}
	const second = {
		videoId: 'QA0xYMAMjEg',
		title: 'Introducing Kody: Your Personal Software Factory',
	}
	const third = {
		videoId: 'o5L5OprLhBg',
		title: 'Kody fixes a Stripe webhook after we renamed the domain',
	}
	const presented = presentLandingHeroVideos([
		first,
		second,
		third,
		{
			videoId: 'OZKDO9Pzmo0',
			title: 'Stop Sweating Agent Switching',
		},
	])
	expect(presented.map((video) => video.videoId)).toEqual([
		first.videoId,
		second.videoId,
		third.videoId,
		'OZKDO9Pzmo0',
	])
	expect(presented[0]?.title).toBe(first.title)
	expect(presented[3]?.title).toBe(landingHeroHeadline)
})
