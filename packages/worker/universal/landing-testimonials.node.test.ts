import { expect, test } from 'vitest'
import {
	landingTestimonials,
	shuffleTestimonials,
	testimonialInitials,
} from '#universal/landing-testimonials.ts'

test('landing testimonials ship the two cleared quotes as structured data without emails', () => {
	expect(landingTestimonials).toHaveLength(2)

	const maciek = landingTestimonials.find(
		(entry) => entry.name === 'Maciek Sitkowski',
	)
	const justin = landingTestimonials.find(
		(entry) => entry.name === 'Justin Elias',
	)

	expect(maciek).toEqual({
		quote:
			"Kody gives my agents one entry point with all my context and tools behind it. I've got into the habit of saying hey kody, so whatever agent I'm in knows to reach for it right away. It's changed how I work with agents day to day.",
		name: 'Maciek Sitkowski',
		photo: '/images/testimonials/maciek-sitkowski.webp',
		href: 'https://macieksitkowski.com',
	})
	expect(justin).toEqual({
		quote:
			'Kody feels like the missing layer between my coding agents and the real systems I need them to operate. My agents still do the thinking and build the software, but Kody gives that work a durable home that isn’t tied to any one agent or tool.',
		name: 'Justin Elias',
		photo: '/images/testimonials/justin-elias.webp',
		href: 'https://www.linkedin.com/in/justin-elias',
	})

	const serialized = JSON.stringify(landingTestimonials)
	expect(serialized).not.toContain('@')
	expect(serialized).not.toContain('community around')
})

test('shuffleTestimonials can grow to six entries and randomizes with the provided RNG', () => {
	const six = [
		...landingTestimonials,
		{
			quote: 'three',
			name: 'Three',
			photo: null,
			href: 'https://example.com/3',
		},
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

	const draws = [0.9, 0.1, 0.5, 0.2, 0.8]
	let draw = 0
	const shuffled = shuffleTestimonials(six, () => draws[draw++] ?? 0)

	expect(shuffled).toHaveLength(6)
	expect(new Set(shuffled.map((entry) => entry.name)).size).toBe(6)
	expect(shuffled.map((entry) => entry.name)).not.toEqual(
		six.map((entry) => entry.name),
	)
	expect(
		shuffleTestimonials(landingTestimonials, () => 0).map(
			(entry) => entry.name,
		),
	).toEqual(['Justin Elias', 'Maciek Sitkowski'])
})

test('testimonialInitials falls back to two letters from the public name', () => {
	expect(testimonialInitials('Maciek Sitkowski')).toBe('MS')
	expect(testimonialInitials('Justin Elias')).toBe('JE')
	expect(testimonialInitials('Ada')).toBe('A')
})
