import { expect, test } from 'vitest'
import { caseStudies, caseStudyAttribution } from '#universal/case-studies.ts'
import { landingTestimonials } from '#universal/landing-testimonials.ts'

test('carousel story anchors resolve to case study ids', () => {
	const caseStudyIds = new Set(caseStudies.map((study) => study.id))
	const storyAnchors = landingTestimonials.flatMap((entry) =>
		'storyAnchor' in entry && entry.storyAnchor ? [entry.storyAnchor] : [],
	)
	expect(storyAnchors.length).toBeGreaterThan(0)
	for (const anchor of storyAnchors) {
		expect(caseStudyIds.has(anchor)).toBe(true)
	}
})

test('caseStudyAttribution joins verified role and employer', () => {
	expect(
		caseStudyAttribution({
			title: 'Frontend Developer',
			company: 'Keto-Mojo',
		}),
	).toBe('Frontend Developer, Keto-Mojo')
	expect(caseStudyAttribution({})).toBeNull()
})
