/**
 * Homepage `?og=` share-card variants.
 *
 * Draft headlines and subtitles. The OG review thread in #marley-market
 * lists the locked keys and doors, but not the headline/subcopy. Marley
 * should replace each string with locked copy before ship. Tone follows
 * the homepage (no em dashes).
 */

import { type LandingPrimitiveId } from '#universal/landing-lantern.ts'
import { type PublicOgPage } from '#universal/og-pages.ts'

export const homeOgQueryParam = 'og'

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

export type HomeOgVariantGroup = 'icp' | 'lantern' | 'triggers-door'

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
		imageTitle: 'Switch agents.\nKeep the work.',
		imageSubtitle: 'The platform your agents share',
	},
	'cursor-claude': {
		group: 'icp',
		highlight: null,
		imageTitle: 'Built in Cursor.\nRuns in Claude.',
		imageSubtitle: 'Packages, secrets, and memory stay',
	},
	skills: {
		group: 'icp',
		highlight: null,
		imageTitle: 'A skill becomes\na package.',
		imageSubtitle: 'Run it from any connected agent',
	},
	forever: {
		group: 'icp',
		highlight: null,
		imageTitle: 'Schedule it once.\nIt keeps running.',
		imageSubtitle: 'No chat left open',
	},
	secrets: {
		group: 'icp',
		highlight: 'secrets',
		imageTitle: 'Keys the model\nnever sees.',
		imageSubtitle: 'Use a connection without reading the key',
	},
	shared: {
		group: 'icp',
		highlight: null,
		imageTitle: 'One home your\nagents share.',
		imageSubtitle: 'Packages, secrets, memory, and jobs',
	},
	memory: {
		group: 'lantern',
		highlight: 'memory',
		imageTitle: "Don't re-explain\nthe same project.",
		imageSubtitle: 'Facts your agents can search later',
	},
	packages: {
		group: 'lantern',
		highlight: 'packages',
		imageTitle: 'Write it once.\nAny agent runs it.',
		imageSubtitle: 'Durable software you own',
	},
	integrations: {
		group: 'lantern',
		highlight: 'integrations',
		imageTitle: 'Connect a tool\nonce.',
		imageSubtitle: 'GitHub, Discord, Google, and more',
	},
	apps: {
		group: 'lantern',
		highlight: 'apps',
		imageTitle: 'A page you open,\nnot another chat.',
		imageSubtitle: 'A hosted page a package serves',
	},
	triggers: {
		group: 'triggers-door',
		highlight: 'triggers',
		imageTitle: 'Wake the work\nwithout a chat.',
		imageSubtitle: 'Email, webhooks, cron, and subscriptions',
	},
	webhooks: {
		group: 'triggers-door',
		highlight: 'triggers',
		imageTitle: 'Webhook in.\nYour package runs.',
		imageSubtitle: 'No chat left open',
	},
	email: {
		group: 'triggers-door',
		highlight: 'triggers',
		imageTitle: 'Mail comes in.\nYour package runs.',
		imageSubtitle: 'No chat left open',
	},
	cron: {
		group: 'triggers-door',
		highlight: 'triggers',
		imageTitle: 'On a schedule.\nYour package runs.',
		imageSubtitle: 'No chat left open',
	},
	subscriptions: {
		group: 'triggers-door',
		highlight: 'triggers',
		imageTitle: 'Subscription in.\nYour package runs.',
		imageSubtitle: 'No chat left open',
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
		ogTitle: `${entry.imageTitle.replaceAll('\n', ' ')} · Kody`,
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
