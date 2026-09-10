import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
	landingTestimonials,
	shuffleTestimonials,
	testimonialAttribution,
	testimonialInitials,
	testimonialStoryHref,
} from '#universal/landing-testimonials.ts'

const testimonialsPhotoDir = join(
	import.meta.dirname,
	'../public/images/testimonials',
)
const testimonialsPhotoPrefix = '/images/testimonials/'

test('shuffleTestimonials can grow to six entries and randomizes with the provided RNG', () => {
	const fillers = [
		{
			quote: 'four',
			name: 'Four',
			photo: null,
			href: 'https://example.com/4',
		},
		{
			quote: 'five',
			name: 'Five',
			photo: null,
			href: 'https://example.com/5',
		},
		{
			quote: 'six',
			name: 'Six',
			photo: null,
			href: 'https://example.com/6',
		},
	]
	const six = [...landingTestimonials, ...fillers].slice(0, 6)

	const draws = [0.9, 0.1, 0.5, 0.2, 0.8]
	let draw = 0
	const shuffled = shuffleTestimonials(six, () => draws[draw++] ?? 0)

	expect(shuffled).toHaveLength(6)
	expect(new Set(shuffled.map((entry) => entry.name)).size).toBe(6)
	expect(shuffled.map((entry) => entry.name)).not.toEqual(
		six.map((entry) => entry.name),
	)
})

test('testimonialInitials falls back to two letters from the public name', () => {
	expect(testimonialInitials('Maciek Sitkowski')).toBe('MS')
	expect(testimonialInitials('Justin Elias')).toBe('JE')
	expect(testimonialInitials('Gabriel Alegría')).toBe('GA')
	expect(testimonialInitials('Ada')).toBe('A')
})

test('testimonialAttribution joins verified role and employer and omits blanks', () => {
	expect(
		testimonialAttribution({
			title: 'Software Engineer',
			company: 'IB',
		}),
	).toBe('Software Engineer, IB')
	expect(
		testimonialAttribution({
			title: 'Lead Developer',
			company: 'Lean Labs',
		}),
	).toBe('Lead Developer, Lean Labs')
	expect(testimonialAttribution({ title: 'Front-end Developer' })).toBe(
		'Front-end Developer',
	)
	expect(testimonialAttribution({ company: 'Heartwood LLC' })).toBe(
		'Heartwood LLC',
	)
	expect(testimonialAttribution({})).toBeNull()
	expect(testimonialAttribution({ title: '', company: '' })).toBeNull()
})

test('carousel story links opt in only when a vignette heading exists', () => {
	const josh = landingTestimonials.find(
		(entry) => entry.name === 'Josh Tomaino',
	)
	const jett = landingTestimonials.find((entry) => entry.name === 'Jett Hays')
	const gabriel = landingTestimonials.find(
		(entry) => entry.name === 'Gabriel Alegría',
	)
	if (!josh || !jett || !gabriel) {
		throw new Error('expected Josh, Jett, and Gabriel testimonials')
	}

	expect(testimonialStoryHref(josh)).toBe('/blog/early-kody-users#josh-tomaino')
	expect(testimonialStoryHref(jett)).toBe('/blog/early-kody-users#jett-hays')
	expect(testimonialStoryHref(gabriel)).toBe(
		'/blog/early-kody-users#gabriel-alegria',
	)
	const erik = landingTestimonials.find(
		(entry) => entry.name === 'Erik Rasmussen',
	)
	if (!erik) {
		throw new Error('expected Erik Rasmussen testimonial')
	}
	expect(testimonialStoryHref(erik)).toBeNull()
	expect(testimonialStoryHref({})).toBeNull()
	expect(
		landingTestimonials
			.filter((entry) => testimonialStoryHref(entry) != null)
			.map((entry) => entry.name),
	).toEqual(['Josh Tomaino', 'Jett Hays', 'Gabriel Alegría'])
})

test('every hosted testimonial photo exists under public/images/testimonials', () => {
	for (const entry of landingTestimonials) {
		if (entry.photo == null) continue
		expect(entry.photo.startsWith(testimonialsPhotoPrefix)).toBe(true)
		expect(
			existsSync(
				join(
					testimonialsPhotoDir,
					entry.photo.slice(testimonialsPhotoPrefix.length),
				),
			),
		).toBe(true)
	}
})
