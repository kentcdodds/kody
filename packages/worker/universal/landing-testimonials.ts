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
	/** Verified public occupation or role — omit if unsure. */
	title?: string
	/** Verified public employer — omit if unsure. */
	company?: string
}

export const landingTestimonials = [
	{
		quote:
			'For me, Kody is unbeatable. Being able to write custom pages from my phone using Claude (or any LLM) is crazy. I recently made a simple API wrapper for a product I\'m working on that exposes a Scalar /api/docs page in about two minutes. Now I can just ask Claude "How many users logged in?" or "Reset user\'s password." It\'s awesome!',
		name: 'Bradley Haveman',
		photo: '/images/testimonials/bradley-haveman.webp',
		href: 'https://haveman.ca/',
		title: 'Lead Developer',
		company: 'Lean Labs',
	},
	{
		quote:
			"Kody gives my agents one entry point with all my context and tools behind it. I've got into the habit of saying hey kody, so whatever agent I'm in knows to reach for it right away. It's changed how I work with agents day to day.",
		name: 'Maciek Sitkowski',
		photo: '/images/testimonials/maciek-sitkowski.webp',
		href: 'https://macieksitkowski.com',
		title: 'Frontend Developer',
		company: 'Keto-Mojo',
	},
	{
		quote:
			'Kody feels like the missing layer between my coding agents and the real systems I need them to operate. My agents still do the thinking and build the software, but Kody gives that work a durable home that isn’t tied to any one agent or tool.',
		name: 'Justin Elias',
		photo: '/images/testimonials/justin-elias.webp',
		href: 'https://www.linkedin.com/in/justin-elias-22279a75/',
		company: 'Zoot Enterprises',
	},
	{
		quote:
			'Kody means peace of mind for me when working with agents. All of my tools, whether through MCP or a package I created on the fly, and my skills are always with me, no matter what agent harness I use.',
		name: 'Cameron Pak',
		photo: '/images/testimonials/cameron-pak.webp',
		href: 'https://cameronpak.com',
		title: 'Software Developer',
		company: 'Heartwood LLC',
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

/** Role and employer for the carousel byline. Omits blank parts. */
export function testimonialAttribution(entry: {
	title?: string
	company?: string
}): string | null {
	const parts = [entry.title, entry.company].filter((part): part is string =>
		Boolean(part),
	)
	if (parts.length === 0) return null
	return parts.join(', ')
}
