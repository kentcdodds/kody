import { expect, test } from 'vitest'
import { landingFactoryBeats } from './landing-factory-beats.ts'
import { routes } from './routes.ts'

test('homepage trigger cards point at dedicated docs slugs', () => {
	expect(landingFactoryBeats.map((beat) => beat.title)).toEqual([
		'Flake Hunter',
		'Sentry Issues',
		'Agent inbox',
		'Purchase thanks',
	])
	const slugs = landingFactoryBeats.map((beat) => beat.slug)
	expect(new Set(slugs).size).toBe(slugs.length)
	for (const beat of landingFactoryBeats) {
		expect(beat.slug.length).toBeGreaterThan(0)
		expect(routes.docDetail.href({ slug: beat.slug })).toBe(
			`/docs/${beat.slug}`,
		)
	}
})
