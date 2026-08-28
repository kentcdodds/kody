/**
 * Homepage testimonials. Keep this list data-only — the carousel scales to
 * about six entries without a layout rewrite. Do not invent quotes or fill
 * empty slots; add real cleared quotes only.
 */

export type LandingTestimonial = {
	quote: string
	name: string
	/** Public profile photo under `/images/testimonials/`, or null for initials. */
	photo: string | null
	/** Personal site or primary public social profile. */
	href: string
	/** Short verified public title only — never invent. */
	title?: string
}

export const landingTestimonials = [
	{
		quote:
			"Kody gives my agents one entry point with all my context and tools behind it. I've got into the habit of saying hey kody, so whatever agent I'm in knows to reach for it right away. It's changed how I work with agents day to day.",
		name: 'Maciek Sitkowski',
		photo: '/images/testimonials/maciek-sitkowski.webp',
		href: 'https://macieksitkowski.com',
	},
	{
		quote:
			'Kody feels like the missing layer between my coding agents and the real systems I need them to operate. My agents still do the thinking and build the software, but Kody gives that work a durable home that isn’t tied to any one agent or tool.',
		name: 'Justin Elias',
		photo: '/images/testimonials/justin-elias.webp',
		href: 'https://www.linkedin.com/in/justin-elias',
	},
] as const satisfies ReadonlyArray<LandingTestimonial>

export type LandingTestimonialEntry = (typeof landingTestimonials)[number]

/** Fisher–Yates shuffle. Pass `random` in tests for a deterministic draw. */
export function shuffleTestimonials<T>(
	items: ReadonlyArray<T>,
	random: () => number = Math.random,
): Array<T> {
	const next = [...items]
	for (let index = next.length - 1; index > 0; index -= 1) {
		const swapIndex = Math.floor(random() * (index + 1))
		const current = next[index]!
		next[index] = next[swapIndex]!
		next[swapIndex] = current
	}
	return next
}

export function testimonialInitials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2)
	return parts.map((part) => part[0]?.toUpperCase() ?? '').join('')
}
