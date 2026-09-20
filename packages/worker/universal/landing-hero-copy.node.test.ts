import { expect, test } from 'vitest'
import { landingHeroHeadline } from './landing-home-copy.ts'
import {
	landingHeroCarouselOmittedVideoIds,
	presentLandingHeroVideos,
} from './landing-hero-copy.ts'

test('homepage carousel drops the retired hero thumb and retitles leftover Stop Sweating copy', () => {
	const kept = {
		videoId: 'QA0xYMAMjEg',
		title: 'Introducing Kody: Your Personal Software Factory',
	}
	const presented = presentLandingHeroVideos([
		{
			videoId: landingHeroCarouselOmittedVideoIds[0],
			title: 'Build in Cursor, then run it from Claude Code or ChatGPT',
		},
		kept,
		{
			videoId: 'o5L5OprLhBg',
			title: 'Stop Sweating Agent Switching',
		},
	])
	expect(presented.map((video) => video.videoId)).toEqual([
		kept.videoId,
		'o5L5OprLhBg',
	])
	expect(presented[1]?.title).toBe(landingHeroHeadline)
	expect(JSON.stringify(presented)).not.toMatch(/stop sweating/i)
	expect(JSON.stringify(presented)).not.toMatch(/\u2014|—/)
})
