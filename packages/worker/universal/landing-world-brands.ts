import { docHref } from '#universal/docs-nav.ts'

/**
 * Homepage invite chip wall. Services only — agent hosts stay in the
 * walkthrough catalog and the hero, not this row. Each `icon` is a file in
 * `public/images/icons/{icon}.svg`. Marks come from the same official paths
 * used on onboarding / connect — do not invent lookalikes. `href` is only
 * set when a dedicated docs page already exists.
 */
export const landingWorldBrands = [
	{ label: 'GitHub', icon: 'github', href: docHref('github') },
	{ label: 'Linear', icon: 'linear' },
	{ label: 'Sentry', icon: 'sentry' },
	{ label: 'Cloudflare', icon: 'cloudflare' },
	{ label: 'Slack', icon: 'slack', href: docHref('slack') },
] as const
