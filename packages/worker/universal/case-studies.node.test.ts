import { expect, test } from 'vitest'
import { caseStudies, caseStudyAttribution } from '#universal/case-studies.ts'
import { landingTestimonials } from '#universal/landing-testimonials.ts'

test('case study ids are stable section anchors linked from the carousel', () => {
	expect(caseStudies.map((study) => study.id)).toEqual(['maciek-sitkowski'])
	const maciek = landingTestimonials.find(
		(entry) => entry.name === 'Maciek Sitkowski',
	)
	expect(maciek?.storyAnchor).toBe('maciek-sitkowski')
	expect(maciek?.storyPath).toBe('/case-studies')
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
