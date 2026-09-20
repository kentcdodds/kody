import { docHref } from '#universal/docs-nav.ts'

/**
 * Homepage invite chip wall. Coding hosts and developer services share the
 * same row; the heading calls them services. Each `icon` is a file in
 * `public/images/icons/{icon}.svg`. Marks come from the same official paths
 * used on onboarding / connect — do not invent lookalikes. `href` is only
 * set when a dedicated docs page already exists.
 */
export const landingWorldBrands = [
	{ label: 'Cursor', icon: 'cursor' },
	{ label: 'Claude Code', icon: 'claudecode' },
	{ label: 'ChatGPT', icon: 'chatgpt' },
	{ label: 'Codex', icon: 'codex' },
	{ label: 'Warp', icon: 'warp' },
	{ label: 'Amp', icon: 'amp' },
	{ label: 'Gemini', icon: 'gemini' },
	{ label: 'OpenClaw', icon: 'openclaw' },
	{ label: 'GitHub', icon: 'github', href: docHref('github') },
	{ label: 'Linear', icon: 'linear' },
	{ label: 'Sentry', icon: 'sentry' },
	{ label: 'Cloudflare', icon: 'cloudflare' },
	{ label: 'Slack', icon: 'slack', href: docHref('slack') },
] as const
