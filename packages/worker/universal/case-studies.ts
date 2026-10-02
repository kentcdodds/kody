/**
 * Public case studies shown at `/case-studies`. Keep this list data-only —
 * each entry's `id` is the section heading id (and the homepage carousel
 * `storyAnchor` when linked). Add cleared full stories only.
 */

export type CaseStudy = {
	/** Stable section id — kebab-case ASCII, matches carousel `storyAnchor`. */
	id: string
	name: string
	/** Verified public occupation or role — omit if unsure. */
	title?: string
	/** Verified public employer — omit if unsure. */
	company?: string
	/** Personal site or primary public social profile, or null when none. */
	href: string | null
	/** Full story in the person's voice. */
	body: string
}

export const caseStudies = [
	{
		id: 'maciek-sitkowski',
		name: 'Maciek Sitkowski',
		title: 'Frontend Developer',
		company: 'Keto-Mojo',
		href: 'https://macieksitkowski.com',
		body: 'Before Kody, I kept rebuilding the same setup every time I moved between ChatGPT, Claude, Claude Code, Cursor, GrokBot, or another new agent. My system instructions, memories, integrations, MCP servers, plugins, and skills were scattered across different tools, and some context always stayed behind. With Kody, I connect one MCP server and bring my tools, context, memories, and custom capabilities with me. I’ve built my own reusable packages around it and literally got into the habit of saying “Hey Kody…” so whichever agent I’m using knows where to reach. Today I reported three issues that came from real workflows, and all three fixes were merged within an hour. That portability, together with the fastest feedback loop I’ve experienced with any tool, is why Kody has become the shared layer behind how I work with agents.',
	},
] as const satisfies ReadonlyArray<CaseStudy>

/** Role and employer for the case-study byline. Omits blank parts. */
export function caseStudyAttribution(entry: {
	title?: string
	company?: string
}): string | null {
	const parts = [entry.title, entry.company].filter((part): part is string =>
		Boolean(part),
	)
	if (parts.length === 0) return null
	return parts.join(', ')
}
