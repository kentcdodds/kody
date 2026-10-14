import {
	landingLanternOrbArt,
	type LandingPrimitiveId,
} from '#universal/landing-lantern.ts'

/**
 * One card per primitive. `/features` shows the full card with its
 * interactive widget; the homepage shows `name` and `title` beside a small,
 * decorative copy of the same widget. Keep the order of `landingPrimitiveIds`.
 * Secrets fold into the credentials card (id `integrations`), so they have no
 * card of their own.
 */
export type PrimitiveCard = {
	id: LandingPrimitiveId
	name: string
	title: string
	body: string
	orb: string
}

/** Widget scenes also render on `/features/secrets`, which has no card. */
export type PrimitiveWidgetId = LandingPrimitiveId | 'secrets'

export const primitiveCards = [
	{
		id: 'memory',
		name: 'Memory',
		title: 'Team context every agent can find.',
		body: 'Save the facts and conventions your team keeps repeating. Every connected agent can find the relevant details when it needs them.',
		orb: landingLanternOrbArt.memory,
	},
	{
		id: 'packages',
		name: 'Packages',
		title: 'Tools your whole team can run.',
		body: 'Turn a useful one-off into reusable code. Inspect the source, publish changes, and share a live package or make your own copy.',
		orb: landingLanternOrbArt.packages,
	},
	{
		id: 'triggers',
		name: 'Triggers',
		title: 'Workflows that run with no chat open.',
		body: 'Run your packages when a webhook arrives, mail comes in, or a scheduled check is due. Call an agent when the work needs one.',
		orb: landingLanternOrbArt.triggers,
	},
	{
		id: 'integrations',
		name: 'Credentials',
		title: 'Connect once. Every agent can use it.',
		body: 'API keys, OAuth connections, and MCP servers your agents use but never see. Connect each one once, then reuse it from any agent or package.',
		orb: landingLanternOrbArt.integrations,
	},
	{
		id: 'apps',
		name: 'Apps',
		title: 'A place your team opens to get work done.',
		body: 'Ask your agent for a tool you can open and use. Kody hosts the interface, keeps the package’s data, and lets you share access.',
		orb: landingLanternOrbArt.apps,
	},
] as const satisfies ReadonlyArray<PrimitiveCard>

export function primitiveFeatureHref(id: LandingPrimitiveId) {
	return `/features/${id}`
}
