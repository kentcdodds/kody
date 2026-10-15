import {
	buildClaudeCodeAddCommand,
	buildCopilotCliAddCommand,
	buildMuseSettingsJson,
	buildOpenClawMcpAddCommand,
	buildOpenCodeMcpAddCommand,
	defaultKodyMcpUrl,
	grokBotInstallUrl,
	grokConnectorsUrl,
	kodyChatGptPluginUrl,
	kodyCursorAddPluginCommand,
	kodyCursorMarketplaceUrl,
	museMcpLoginCommand,
	openClawMcpLoginCommand,
	openCodeMcpAuthCommand,
	randomOnboardingInt,
	shuffleOnboardingAgentIds,
	type OnboardingRandomInt,
} from '#universal/onboarding-mcp-clients.ts'

/**
 * Agents with a `/with/:agent` page and a spot in the homepage agent
 * marquee. Each one has a working Kody connect path today (the walkthrough
 * catalog in `walkthrough-hosts.ts`). Steps are the shortest production
 * path from `docs/use/connect-your-agent.md`; Get started and the
 * connect docs keep every alternative.
 */

export type WithAgentStep = {
	text: string
	code?: string
	link?: { label: string; href: string }
}

export type WithAgent = {
	slug: string
	name: string
	/** Monochrome SVG in `public/images/icons/`. */
	icon: string
	pitch: string
	steps: ReadonlyArray<WithAgentStep>
}

const mcpUrl = defaultKodyMcpUrl

const chatGptPluginStep = {
	text: 'Add the Kody plugin from the ChatGPT plugin directory.',
	link: { label: 'Open the Kody plugin', href: kodyChatGptPluginUrl },
} satisfies WithAgentStep

export const withAgents = [
	{
		slug: 'cursor',
		name: 'Cursor',
		icon: 'cursor',
		pitch:
			'Keep building in Cursor. Kody gives it your team\u2019s credentials, packages, and workflows, and anything it saves runs from every other agent your team uses.',
		steps: [
			{
				text: 'Install the Kody plugin from the Cursor Marketplace.',
				link: { label: 'Open the Kody plugin', href: kodyCursorMarketplaceUrl },
			},
			{ text: 'Or run this in Cursor chat:', code: kodyCursorAddPluginCommand },
			{
				text: 'Choose Authenticate next to Kody in Cursor\u2019s MCP list, then approve access.',
			},
		],
	},
	{
		slug: 'claude-code',
		name: 'Claude Code',
		icon: 'claudecode',
		pitch:
			'Claude Code writes the package. Kody keeps it, runs it on a trigger, and shares it with the rest of your team.',
		steps: [
			{
				text: 'Add Kody from your terminal:',
				code: buildClaudeCodeAddCommand(mcpUrl),
			},
			{ text: 'In Claude Code, run /mcp, choose Kody, then Authenticate.' },
		],
	},
	{
		slug: 'codex',
		name: 'Codex',
		icon: 'codex',
		pitch:
			'Let Codex build tools your whole team can run, with credentials it uses but never sees.',
		steps: [
			chatGptPluginStep,
			{ text: 'Approve access when Codex asks you to sign in to Kody.' },
		],
	},
	{
		slug: 'chatgpt',
		name: 'ChatGPT',
		icon: 'chatgpt',
		pitch:
			'Use your team\u2019s packages and connected accounts from a ChatGPT conversation, on the web or on your phone.',
		steps: [
			chatGptPluginStep,
			{
				text: 'Approve access when ChatGPT asks you to sign in to Kody. Plugins need a paid ChatGPT plan.',
			},
		],
	},
	{
		slug: 'claude',
		name: 'Claude',
		icon: 'claude',
		pitch:
			'Bring your team\u2019s tools and connected accounts into Claude conversations on desktop, web, and mobile.',
		steps: [
			{
				text: 'In Claude, open Settings, then Connectors, and add a custom connector with this URL:',
				code: mcpUrl,
			},
			{
				text: 'Approve access, then start a new chat and ask Claude to list its Kody tools.',
			},
		],
	},
	{
		slug: 'copilot',
		name: 'GitHub Copilot',
		icon: 'githubcopilot',
		pitch:
			'Give Copilot in VS Code or the terminal the same credentials and packages the rest of your team uses.',
		steps: [
			{
				text: 'Add Kody to Copilot CLI:',
				code: buildCopilotCliAddCommand(mcpUrl),
			},
			{
				text: 'Approve access when Copilot asks you to sign in. In VS Code, add the same URL as an HTTP MCP server and use Agent mode.',
			},
		],
	},
	{
		slug: 'devin',
		name: 'Devin',
		icon: 'devin',
		pitch:
			'Let Devin use your team\u2019s credentials and packages without pasting a single key into a session.',
		steps: [
			{
				text: 'In Devin, add a custom remote MCP server with this URL:',
				code: mcpUrl,
			},
			{ text: 'Approve access when Devin opens the sign-in window.' },
		],
	},
	{
		slug: 'gemini',
		name: 'Gemini',
		icon: 'gemini',
		pitch:
			'Run your team\u2019s packages from the Gemini app, with credentials Gemini never sees.',
		steps: [
			{
				text: 'In the Gemini app, add a custom MCP connector with this URL:',
				code: mcpUrl,
			},
			{ text: 'Approve access when Google prompts you.' },
		],
	},
	{
		slug: 'grok',
		name: 'Grok',
		icon: 'grok',
		pitch:
			'Bring your team\u2019s tools into Grok conversations through one custom connector.',
		steps: [
			{
				text: 'Open Grok connectors, choose New Connector, then Custom.',
				link: { label: 'Open Grok connectors', href: grokConnectorsUrl },
			},
			{ text: 'Paste this URL, then approve access:', code: mcpUrl },
		],
	},
	{
		slug: 'grok-bot',
		name: 'Grok Bot',
		icon: 'grokbot',
		pitch:
			'Add Kody to Grok Bot in one click and reach your team\u2019s packages from your desktop assistant.',
		steps: [
			{
				text: 'Add the Kody plugin to Grok Bot.',
				link: { label: 'Add Kody to Grok Bot', href: grokBotInstallUrl },
			},
			{ text: 'Or open Plugins in the Grok Bot sidebar and add Kody.' },
		],
	},
	{
		slug: 'opencode',
		name: 'OpenCode',
		icon: 'opencode',
		pitch:
			'Point OpenCode at Kody, and every package it writes becomes something your whole team can run.',
		steps: [
			{
				text: 'Add Kody from your terminal:',
				code: buildOpenCodeMcpAddCommand(mcpUrl),
			},
			{ text: 'Then sign in:', code: openCodeMcpAuthCommand },
		],
	},
	{
		slug: 'openclaw',
		name: 'OpenClaw',
		icon: 'openclaw',
		pitch:
			'Give your local-first OpenClaw agent the shared credentials and workflows your team keeps in Kody.',
		steps: [
			{
				text: 'Add Kody from your terminal:',
				code: buildOpenClawMcpAddCommand(mcpUrl),
			},
			{ text: 'Then sign in:', code: openClawMcpLoginCommand },
		],
	},
	{
		slug: 'muse',
		name: 'Muse',
		icon: 'muse',
		pitch:
			'Connect Muse Code to Kody so the tools it builds outlive the session and reach the rest of your team.',
		steps: [
			{
				text: 'Add Kody to ~/.config/muse/settings.json:',
				code: buildMuseSettingsJson(mcpUrl).trimEnd(),
			},
			{ text: 'Then sign in:', code: museMcpLoginCommand },
		],
	},
] as const satisfies ReadonlyArray<WithAgent>

export type WithAgentSlug = (typeof withAgents)[number]['slug']

export function findWithAgent(slug: string): WithAgent | null {
	return withAgents.find((agent) => agent.slug === slug) ?? null
}

export function withAgentHref(slug: string) {
	return `/with/${slug}`
}

export function findWithAgentByPathname(pathname: string): WithAgent | null {
	const slug = /^\/with\/([^/]+)\/?$/.exec(pathname)?.[1]
	return slug ? findWithAgent(slug) : null
}

export function withAgentIconSrc(agent: Pick<WithAgent, 'icon'>) {
	return `/images/icons/${agent.icon}.svg`
}

/** One SSR shuffle for the homepage marquee, carried in loader data so hydrate matches. */
export function pickWithAgentOrder(
	randomInt: OnboardingRandomInt = randomOnboardingInt,
): Array<WithAgentSlug> {
	return shuffleOnboardingAgentIds(
		withAgents.map((agent) => agent.slug),
		randomInt,
	)
}

/** Loader data is untrusted; keep only known slugs and fill in any missing ones. */
export function resolveWithAgentOrder(
	order: ReadonlyArray<string> | null | undefined,
): Array<WithAgent> {
	const seen = new Set<string>()
	const ordered: Array<WithAgent> = []
	for (const slug of order ?? []) {
		const agent = findWithAgent(slug)
		if (!agent || seen.has(slug)) continue
		seen.add(slug)
		ordered.push(agent)
	}
	for (const agent of withAgents) {
		if (!seen.has(agent.slug)) ordered.push(agent)
	}
	return ordered
}
