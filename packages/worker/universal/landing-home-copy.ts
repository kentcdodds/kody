/**
 * Locked kody.codes homepage copy (hero plus the early-scroll sections).
 * Keep these strings exact. Do not invent positioning or swap in synonyms.
 */

export const landingHeroHeadlineLead =
	'You shouldn\u2019t have to start over in '
export const landingHeroHeadlineEmphasis = 'every agent.'
export const landingHeroHeadline = `${landingHeroHeadlineLead}${landingHeroHeadlineEmphasis}`

export const landingHeroSubheadLead = 'Kody is the '
export const landingHeroSubheadEmphasis = 'software platform'
export const landingHeroSubheadTail = ' your agents share'
export const landingHeroSubhead = `${landingHeroSubheadLead}${landingHeroSubheadEmphasis}${landingHeroSubheadTail}`
export const landingHeroLead =
	'One home for packages, secrets, memory, and jobs, so what you build in Cursor still runs in Claude.'
export const landingHeroPrimaryCta = 'Connect your agent'
export const landingHeroSecondaryCta = 'See how it works'

export const landingPrimitivesIntroLead =
	'Kody gives your agents a shared set of primitives: '
export const landingPrimitivesMoreLead = 'Want the full picture?'
export const landingPrimitivesMoreLink = 'What is Kody?'

export const landingHomePrimitives = [
	{
		id: 'memory',
		word: 'memory',
		body: 'Facts and context your agents can search later, across hosts. You stop re-explaining the same project every session.',
	},
	{
		id: 'secrets',
		word: 'secrets',
		body: 'Keys and tokens the model never sees. Your agent can use a connection without reading the credential.',
	},
	{
		id: 'packages',
		word: 'packages',
		body: 'Durable software you own. An agent writes it once; any connected agent can run it.',
	},
	{
		id: 'jobs',
		word: 'jobs',
		body: 'Cron, webhooks, email, and events that run the package. Often with no model in the loop.',
	},
	{
		id: 'integrations',
		word: 'integrations',
		body: 'Signed-in connections to the tools you already use (GitHub, Discord, Google, and more), reusable from any agent.',
	},
] as const

export type LandingHomePrimitive = (typeof landingHomePrimitives)[number]

export const landingVsHeading = 'Not another chat. Not another gateway.'

export const landingVsItems = [
	{
		kicker: 'Skills files and copy-paste.',
		body: 'A skill in one agent stays stuck there. On Kody it becomes a package you run from Cursor, Claude, Codex, or ChatGPT.',
	},
	{
		kicker: 'Multi-model tabs and routers.',
		body: 'Switching models is not the same as keeping the work. Kody holds the memory, secrets, and packages those models call.',
	},
	{
		kicker: 'MCP gateways.',
		body: 'Great at connecting tools. Kody is where the useful work becomes software you own, schedule, and reuse.',
	},
] as const

export const landingCompareWithoutTitle = 'Without Kody'
export const landingCompareWithTitle = 'With Kody'
export const landingCompareCaption = 'Ask once. Save it. Trigger it.'

export const landingCompareWithoutItems = [
	'Re-teach the agent each session',
	'Re-wire secrets per host',
	'Rebuild the same automation when you change agents',
] as const

export const landingCompareWithItems = [
	'Memory and packages live in one home',
	'Secrets stay usable without landing in the prompt',
	'Trigger the same package from cron, webhook, email, or any connected agent',
] as const

export const landingProofHeading = 'See it work'

export function landingHomeUiCopyBlob() {
	return [
		landingHeroHeadline,
		landingHeroSubhead,
		landingHeroLead,
		landingHeroPrimaryCta,
		landingHeroSecondaryCta,
		landingPrimitivesIntroLead,
		landingPrimitivesMoreLead,
		landingPrimitivesMoreLink,
		...landingHomePrimitives.flatMap((item) => [item.word, item.body]),
		landingVsHeading,
		...landingVsItems.flatMap((item) => [item.kicker, item.body]),
		landingCompareWithoutTitle,
		landingCompareWithTitle,
		landingCompareCaption,
		...landingCompareWithoutItems,
		...landingCompareWithItems,
		landingProofHeading,
	].join('\n')
}
