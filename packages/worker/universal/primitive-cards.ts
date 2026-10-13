import {
	landingLanternOrbArt,
	type LandingPrimitiveId,
} from '#universal/landing-lantern.ts'

/**
 * One card per primitive. `/features` shows the full card with its
 * interactive widget; the homepage shows `name` and `title` beside a small,
 * decorative copy of the same widget. Keep the order of `landingPrimitiveIds`.
 */
export type PrimitiveCard = {
	id: LandingPrimitiveId
	name: string
	title: string
	body: string
	orb: string
}

export const primitiveCards = [
	{
		id: 'memory',
		name: 'Memory',
		title: 'Context that comes with you.',
		body: 'Save the facts and preferences you keep repeating. Your connected agents can find the relevant details when they need them.',
		orb: landingLanternOrbArt.memory,
	},
	{
		id: 'secrets',
		name: 'Secrets',
		title: 'Access without handing over the key.',
		body: 'Let your agent use credentials through Kody. Approve where they can be sent and which packages can use them.',
		orb: landingLanternOrbArt.secrets,
	},
	{
		id: 'packages',
		name: 'Packages',
		title: 'Keep the software your agent builds.',
		body: 'Turn a useful one-off into reusable code. Inspect the source, publish changes, and share a live package or make your own copy.',
		orb: landingLanternOrbArt.packages,
	},
	{
		id: 'triggers',
		name: 'Triggers',
		title: 'Keep working after the chat closes.',
		body: 'Run your packages when a webhook arrives, mail comes in, or a scheduled check is due. Call an agent when the work needs one.',
		orb: landingLanternOrbArt.triggers,
	},
	{
		id: 'integrations',
		name: 'Integrations',
		title: 'Connect your accounts once.',
		body: 'Keep named service connections in Kody and reuse them across packages. The connection supplies access, the package does the work.',
		orb: landingLanternOrbArt.integrations,
	},
	{
		id: 'apps',
		name: 'Apps',
		title: 'Give your work a place to happen.',
		body: 'Ask your agent for a tool you can open and use. Kody hosts the interface, keeps the package’s data, and lets you share access.',
		orb: landingLanternOrbArt.apps,
	},
] as const satisfies ReadonlyArray<PrimitiveCard>

export function primitiveFeatureHref(id: LandingPrimitiveId) {
	return `/features/${id}`
}
