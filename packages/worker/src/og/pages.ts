/**
 * Registry of public pages that get a Satori-generated OG image at
 * `/og/:page.png`. The page id is the `:page` path segment; `path` is the
 * canonical page path the OG tags point at.
 *
 * Kept separate from `page-image.ts` so handlers can read titles and
 * descriptions without pulling satori/resvg into the isolate.
 */
export type PublicOgPage = {
	/** Large heading inside the generated image. */
	imageTitle: string
	/** Muted supporting line inside the generated image. */
	imageSubtitle: string
	/** `og:title` / `twitter:title` for the page. */
	ogTitle: string
	/** `og:description` / `twitter:description` for the page. */
	ogDescription: string
	/** Canonical page path (used for `og:url` and the canonical link). */
	path: string
}

export const publicOgPages = {
	home: {
		imageTitle: "Your assistant's home",
		imageSubtitle:
			"Your assistant's home — memory, keys, code, and automations, portable across every MCP host.",
		ogTitle: "Kody — your assistant's home",
		ogDescription:
			"Your assistant's home — memory, keys, code, and automations, portable across every MCP host.",
		path: '/',
	},
	community: {
		imageTitle: 'Community packages',
		imageSubtitle:
			'Browse packages shared by Kody users, fork them into your own assistant, and rate what works.',
		ogTitle: 'Community packages — Kody',
		ogDescription: 'Browse community packages shared by Kody users.',
		path: '/community',
	},
	blog: {
		imageTitle: 'Kody Blog',
		imageSubtitle:
			'Updates and positioning posts from Kent C. Dodds about Kody.',
		ogTitle: 'Blog — Kody',
		ogDescription:
			'Updates and positioning posts from Kent C. Dodds about Kody.',
		path: '/blog',
	},
	login: {
		imageTitle: 'Welcome back',
		imageSubtitle: 'Log in to continue to kody.',
		ogTitle: 'Sign in — Kody',
		ogDescription: 'Log in to continue to kody.',
		path: '/login',
	},
	signup: {
		imageTitle: 'Create your account',
		imageSubtitle: 'Sign up to start using kody.',
		ogTitle: 'Sign up — Kody',
		ogDescription: 'Sign up to start using kody.',
		path: '/signup',
	},
	privacy: {
		imageTitle: 'Privacy',
		imageSubtitle:
			'How Kody stores your data and what a deployment admin can see.',
		ogTitle: 'Privacy — Kody',
		ogDescription:
			'How Kody stores your data and what a deployment admin can see.',
		path: '/privacy',
	},
	terms: {
		imageTitle: 'Terms',
		imageSubtitle: 'Terms and acceptable use for this Kody deployment.',
		ogTitle: 'Terms — Kody',
		ogDescription: 'Terms and acceptable use for this Kody deployment.',
		path: '/terms',
	},
	onboarding: {
		imageTitle: 'Get started with Kody',
		imageSubtitle:
			'Connect your AI agent host and set up your personal assistant.',
		ogTitle: 'Get started — Kody',
		ogDescription:
			'Connect your AI agent host and set up your personal assistant.',
		path: '/onboarding',
	},
	'reset-password': {
		imageTitle: 'Reset your password',
		imageSubtitle: 'Choose a new password for your kody account.',
		ogTitle: 'Reset password — Kody',
		ogDescription: 'Choose a new password for your kody account.',
		path: '/reset-password',
	},
} as const satisfies Record<string, PublicOgPage>

export type PublicOgPageId = keyof typeof publicOgPages

export function getPublicOgPage(pageId: string): PublicOgPage | null {
	if (Object.hasOwn(publicOgPages, pageId)) {
		return publicOgPages[pageId as PublicOgPageId]
	}
	return null
}
