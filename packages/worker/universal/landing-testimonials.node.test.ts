import { expect, test } from 'vitest'
import {
	landingTestimonials,
	shuffleTestimonials,
	testimonialInitials,
} from '#universal/landing-testimonials.ts'

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
	expect(
		shuffleTestimonials(landingTestimonials, () => 0).map(
			(entry) => entry.name,
		),
	).toEqual(['Justin Elias', 'Cameron Pak', 'Maciek Sitkowski'])
})

test('testimonialInitials falls back to two letters from the public name', () => {
	expect(testimonialInitials('Maciek Sitkowski')).toBe('MS')
	expect(testimonialInitials('Justin Elias')).toBe('JE')
	expect(testimonialInitials('Ada')).toBe('A')
})
