/**
 * Public case studies shown at `/case-studies`. Keep this list data-only —
 * each entry's `id` is the section heading id (and the homepage carousel
 * `storyAnchor` when linked). Bodies stay in sync with the case-studies blog
 * post (`early-kody-users`). Add cleared full stories only.
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
		id: 'josh-tomaino',
		name: 'Josh Tomaino',
		title: 'Engineering Manager',
		company: 'Cloverleaf.me',
		href: 'https://copyjosh.com/',
		body: "Been running Kody for a while. My personal agent for my family lives on a VPS, I run a local agent for work, and between my organization and myself we pay for six accounts over four different providers. I don't want my personal tokens spread over my work harnesses and I can't have my tokens for work spread across my personal devices. Kody provides a crucial layer of infrastructure that funnels all my tools into one secure MCP I can manage myself, instead of me wiring up each one across different apps and environments. The interoperability is the real magic - the same tools serve my family agent and the work agent I run separately, no duplicate setup. It just works.",
	},
	{
		id: 'jett-hays',
		name: 'Jett Hays',
		title: 'Head of Software',
		company: 'Sentala',
		href: 'https://sentala.org',
		body: "Kody gives our agents durable and credentialed access to infrastructure. Agents own deployment automation, while Kody owns the secure execution layer. We operate in contested environments where a downed service could mean life or death for some of the world's most endangered species. Kody helps us keep that critical infrastructure running.",
	},
	{
		id: 'gabriel-alegria',
		name: 'Gabriel Alegría',
		title: 'Software Engineer',
		company: 'IB',
		href: 'https://www.linkedin.com/in/gabriel-alegria-mx',
		body: 'I started with jobs for my business health checks: a package that hits Railway and posts specific output to Discord on a private server. Then the agent suggested a task-list package tailored to me, and I built it. I am even thinking about leaving Linear behind for small projects.\n\nI have only scratched the surface, and Kody already changed how I work. Everything I need is condensed in one place. I can store wacky ideas and not lose them the way I always did with Notion.',
	},
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
