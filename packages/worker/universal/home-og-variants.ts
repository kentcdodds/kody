/**
 * Homepage `?og=` share-card variants.
 *
 * Headlines and subtitles are Marley's locked copy. `og:title` is the H1
 * and `og:description` is the sub, with no extra suffix. The default home
 * card (no param) stays in `og-pages.ts`.
 */

import { type LandingPrimitiveId } from '#universal/landing-lantern.ts'
import { type PublicOgPage } from '#universal/og-pages.ts'

const homeOgQueryParam = 'og'

export const homeOgVariantIds = [
	'switch',
	'cursor-claude',
	'skills',
	'forever',
	'secrets',
	'shared',
	'memory',
	'packages',
	'integrations',
	'apps',
	'triggers',
	'webhooks',
	'email',
	'cron',
	'subscriptions',
] as const

export type HomeOgVariantId = (typeof homeOgVariantIds)[number]

type HomeOgVariantGroup = 'icp' | 'lantern' | 'triggers-door'

type HomeOgVariantEntry = {
	group: HomeOgVariantGroup
	/** Primitive to ring in the lantern. Null keeps every orb equal. */
	highlight: LandingPrimitiveId | null
	imageTitle: string
	imageSubtitle: string
}

/**
 * `secrets` is an ICP door that also highlights the secrets orb.
 * `triggers` is the generic triggers door (same orb as the other doors).
 */
const homeOgVariants = {
	switch: {
		group: 'icp',
		highlight: null,
		imageTitle: 'Switch agents. Keep the work.',
		imageSubtitle: 'Memory, secrets, and packages that travel with you',
	},
	'cursor-claude': {
		group: 'icp',
		highlight: null,
		imageTitle: 'Built in Cursor. Run it in Claude.',
		imageSubtitle: 'One package graph every agent can call',
	},
	skills: {
		group: 'icp',
		highlight: null,
		imageTitle: 'Turn a skill into software you own',
		imageSubtitle: 'Save it once. Invoke it from any MCP host',
	},
	forever: {
		group: 'icp',
		highlight: null,
		imageTitle: 'Say it once. Run it forever.',
		imageSubtitle: "Packages and jobs that don't need a chat open",
	},
	secrets: {
		group: 'icp',
		highlight: 'secrets',
		imageTitle: 'Secrets your agents can use, not read',
		imageSubtitle: 'The vault stays yours across every host',
	},
	shared: {
		group: 'icp',
		highlight: null,
		imageTitle: 'The software platform your agents share',
		imageSubtitle: 'One home for memory, packages, and jobs',
	},
	memory: {
		group: 'lantern',
		highlight: 'memory',
		imageTitle: 'Stop re-explaining yourself to every agent',
		imageSubtitle: 'Shared memory your agents actually use',
	},
	packages: {
		group: 'lantern',
		highlight: 'packages',
		imageTitle: 'Own the answer as a package',
		imageSubtitle: 'Invoke it from any MCP host',
	},
	integrations: {
		group: 'lantern',
		highlight: 'integrations',
		imageTitle: 'Connect the tools. Keep the software',
		imageSubtitle: 'Integrations your packages call, not chat glue',
	},
	apps: {
		group: 'lantern',
		highlight: 'apps',
		imageTitle: 'Your agents share a real app surface',
		imageSubtitle: 'Connect services. Keep the software',
	},
	triggers: {
		group: 'triggers-door',
		highlight: 'triggers',
		imageTitle: 'When it fires, your package runs',
		imageSubtitle: 'Email, cron, and webhooks into software you own',
	},
	webhooks: {
		group: 'triggers-door',
		highlight: 'triggers',
		imageTitle: 'Events in. Owned software out.',
		imageSubtitle: 'Webhooks that wake packages you control',
	},
	email: {
		group: 'triggers-door',
		highlight: 'triggers',
		imageTitle: 'When the email lands, the package runs',
		imageSubtitle: 'Mail that starts work \u2014 not another inbox tab',
	},
	cron: {
		group: 'triggers-door',
		highlight: 'triggers',
		imageTitle: 'Say it once. Run it on a schedule.',
		imageSubtitle: 'Jobs that keep going with no chat open',
	},
	subscriptions: {
		group: 'triggers-door',
		highlight: 'triggers',
		imageTitle: 'When the subscription fires, the package runs',
		imageSubtitle: 'Stripe and billing events into software you own',
	},
} as const satisfies Record<HomeOgVariantId, HomeOgVariantEntry>

export type HomeOgVariant = HomeOgVariantEntry & {
	id: HomeOgVariantId
	ogTitle: string
	ogDescription: string
}

export function isHomeOgVariantId(value: string): value is HomeOgVariantId {
	return Object.hasOwn(homeOgVariants, value)
}

export function getHomeOgVariant(
	value: string | null | undefined,
): HomeOgVariant | null {
	if (!value || !isHomeOgVariantId(value)) return null
	const entry = homeOgVariants[value]
	return {
		id: value,
		group: entry.group,
		highlight: entry.highlight,
		imageTitle: entry.imageTitle,
		imageSubtitle: entry.imageSubtitle,
		ogTitle: entry.imageTitle,
		ogDescription: entry.imageSubtitle,
	}
}

/** `?og=` on a URL, or a bare query string. Unknown values are null. */
export function readHomeOgVariant(search: string): HomeOgVariant | null {
	return getHomeOgVariant(new URLSearchParams(search).get(homeOgQueryParam))
}

/** Image route that actually renders this variant. */
export function homeOgImagePath(id: HomeOgVariantId): string {
	return `/og/home.png?${homeOgQueryParam}=${id}`
}

export function applyHomeOgVariant(
	page: PublicOgPage,
	variant: HomeOgVariant,
): PublicOgPage {
	return {
		...page,
		imageTitle: variant.imageTitle,
		imageSubtitle: variant.imageSubtitle,
		ogTitle: variant.ogTitle,
		ogDescription: variant.ogDescription,
	}
}

/**
 * Path for `history.replaceState` after dropping `og`. Null when the param
 * is already absent. Other params and the hash stay.
 */
export function locationWithoutHomeOgParam(href: string): string | null {
	let url: URL
	try {
		url = new URL(href)
	} catch {
		return null
	}
	if (!url.searchParams.has(homeOgQueryParam)) return null
	url.searchParams.delete(homeOgQueryParam)
	return `${url.pathname}${url.search}${url.hash}`
}
