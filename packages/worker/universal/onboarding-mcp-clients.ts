/**
 * Per-client MCP setup snippets and copy for the onboarding page.
 * Keep this module free of Remix/UI so config builders stay unit-testable
 * and origin can highlight the same snippets the tabs render.
 */

import { breakpoints } from '#universal/styles/tokens.ts'

export type McpClientKind =
	| 'cursor'
	| 'chatgpt'
	| 'codex'
	| 'claude-desktop'
	| 'grok'
	| 'grok-cli'
	| 'grok-bot'
	| 'claude-code'
	| 'opencode'
	| 'copilot'
	| 'copilot-app'
	| 'devin'
	| 'gemini'
	| 'openclaw'
	| 'other'

export type OnboardingAgentSurface = 'desktop' | 'mobile'

export type McpClientTab = {
	id: McpClientKind
	label: string
	/** True for hosts that are primarily chat/non-coding agents. */
	isNonCodingAgent: boolean
}

export const mcpClientTabs = [
	{ id: 'cursor', label: 'Cursor', isNonCodingAgent: false },
	{ id: 'chatgpt', label: 'ChatGPT.com', isNonCodingAgent: true },
	{ id: 'codex', label: 'Codex', isNonCodingAgent: false },
	{ id: 'claude-desktop', label: 'Claude Desktop', isNonCodingAgent: true },
	{ id: 'grok', label: 'Grok.com', isNonCodingAgent: true },
	{ id: 'grok-cli', label: 'Grok CLI', isNonCodingAgent: false },
	{ id: 'grok-bot', label: 'Grok Bot', isNonCodingAgent: true },
	{ id: 'claude-code', label: 'Claude Code', isNonCodingAgent: false },
	{ id: 'opencode', label: 'OpenCode', isNonCodingAgent: false },
	{ id: 'copilot', label: 'Copilot', isNonCodingAgent: false },
	{ id: 'copilot-app', label: 'Copilot App', isNonCodingAgent: true },
	{ id: 'devin', label: 'Devin', isNonCodingAgent: false },
	{ id: 'gemini', label: 'Gemini', isNonCodingAgent: true },
	{ id: 'openclaw', label: 'OpenClaw', isNonCodingAgent: false },
	{ id: 'other', label: 'Other', isNonCodingAgent: false },
] as const satisfies ReadonlyArray<McpClientTab>

/**
 * Desktop chooser: coding agents first, then the highest-traffic chat hosts
 * that are not already represented. Devin stands in for Devin Desktop
 * (ex-Windsurf). OpenCode is the Cline / OpenCode slot. OpenClaw is the
 * local-first personal-AI slot. ChatGPT.com, Claude Desktop, and Gemini
 * fill the three leftover seats after OpenClaw so the auto-fill desktop
 * grid lands on complete rows with Not listed (12 cards). Grok.com,
 * Grok CLI, and the Copilot app stay under Not listed (Copilot
 * desktop/CLI is already featured; Aider is not a Kody connect path yet).
 */
export const onboardingDesktopFeaturedAgentIds = [
	'claude-code',
	'cursor',
	'codex',
	'copilot',
	'devin',
	'opencode',
	'openclaw',
	'chatgpt',
	'claude-desktop',
	'gemini',
	'grok-bot',
] as const satisfies ReadonlyArray<McpClientKind>

/**
 * Phone chooser: hosts you can start from a pocket. Codex and Claude Code
 * use the ChatGPT / Claude apps. Replit is not a Kody connect path yet, so
 * Grok Bot fills the seventh seat.
 */
export const onboardingMobileFeaturedAgentIds = [
	'chatgpt',
	'claude-desktop',
	'devin',
	'cursor',
	'copilot-app',
	'gemini',
	'grok-bot',
] as const satisfies ReadonlyArray<McpClientKind>

/** Narrow viewport or a coarse phone-like pointer. */
export const onboardingMobileAgentMediaQuery = `(max-width: ${breakpoints.mobile}), (hover: none) and (pointer: coarse)`

export const onboardingMobileAgentMq = `@media ${onboardingMobileAgentMediaQuery}`

export function onboardingFeaturedAgentIdsFor(
	surface: OnboardingAgentSurface,
): ReadonlyArray<McpClientKind> {
	return surface === 'mobile'
		? onboardingMobileFeaturedAgentIds
		: onboardingDesktopFeaturedAgentIds
}

export function onboardingMoreAgentIdsFor(
	surface: OnboardingAgentSurface,
): Array<McpClientKind> {
	const featured = new Set<McpClientKind>(
		onboardingFeaturedAgentIdsFor(surface),
	)
	return mcpClientTabs
		.map((tab) => tab.id)
		.filter((id) => id !== 'other' && !featured.has(id))
}

export type OnboardingRandomInt = (maxExclusive: number) => number

export type OnboardingAgentChooserPick = {
	desktopFeatured: Array<McpClientKind>
	mobileFeatured: Array<McpClientKind>
	desktopMore: Array<McpClientKind>
	mobileMore: Array<McpClientKind>
}

export function randomOnboardingInt(maxExclusive: number): number {
	if (maxExclusive <= 0) {
		throw new Error('randomOnboardingInt requires a positive maximum')
	}
	const bytes = new Uint32Array(1)
	crypto.getRandomValues(bytes)
	return bytes[0]! % maxExclusive
}

export function shuffleOnboardingAgentIds(
	ids: ReadonlyArray<McpClientKind>,
	randomInt: OnboardingRandomInt = randomOnboardingInt,
): Array<McpClientKind> {
	const next = [...ids]
	for (let index = next.length - 1; index > 0; index--) {
		const span = index + 1
		const raw = randomInt(span)
		const swapAt = ((raw % span) + span) % span
		const current = next[index]
		const other = next[swapAt]
		if (!current || !other) continue
		next[index] = other
		next[swapAt] = current
	}
	return next
}

/** One SSR pick so hydrate matches. Polls must not reshuffle. */
export function pickOnboardingAgentChooser(
	randomInt: OnboardingRandomInt = randomOnboardingInt,
): OnboardingAgentChooserPick {
	return {
		desktopFeatured: shuffleOnboardingAgentIds(
			onboardingDesktopFeaturedAgentIds,
			randomInt,
		),
		mobileFeatured: shuffleOnboardingAgentIds(
			onboardingMobileFeaturedAgentIds,
			randomInt,
		),
		desktopMore: shuffleOnboardingAgentIds(
			onboardingMoreAgentIdsFor('desktop'),
			randomInt,
		),
		mobileMore: shuffleOnboardingAgentIds(
			onboardingMoreAgentIdsFor('mobile'),
			randomInt,
		),
	}
}

export function canonicalOnboardingAgentChooser(): OnboardingAgentChooserPick {
	return {
		desktopFeatured: [...onboardingDesktopFeaturedAgentIds],
		mobileFeatured: [...onboardingMobileFeaturedAgentIds],
		desktopMore: onboardingMoreAgentIdsFor('desktop'),
		mobileMore: onboardingMoreAgentIdsFor('mobile'),
	}
}

function isPermutation(
	actual: ReadonlyArray<McpClientKind>,
	expected: ReadonlyArray<McpClientKind>,
) {
	if (actual.length !== expected.length) return false
	const expectedIds = new Set(expected)
	if (new Set(actual).size !== expectedIds.size) return false
	return actual.every((id) => expectedIds.has(id))
}

export function isValidOnboardingAgentChooserPick(
	value: OnboardingAgentChooserPick,
): boolean {
	return (
		isPermutation(value.desktopFeatured, onboardingDesktopFeaturedAgentIds) &&
		isPermutation(value.mobileFeatured, onboardingMobileFeaturedAgentIds) &&
		isPermutation(value.desktopMore, onboardingMoreAgentIdsFor('desktop')) &&
		isPermutation(value.mobileMore, onboardingMoreAgentIdsFor('mobile'))
	)
}

export function onboardingFeaturedIdsFromChooser(
	chooser: OnboardingAgentChooserPick,
	surface: OnboardingAgentSurface,
): ReadonlyArray<McpClientKind> {
	return surface === 'mobile' ? chooser.mobileFeatured : chooser.desktopFeatured
}

export function onboardingMoreIdsFromChooser(
	chooser: OnboardingAgentChooserPick,
	surface: OnboardingAgentSurface,
): ReadonlyArray<McpClientKind> {
	return surface === 'mobile' ? chooser.mobileMore : chooser.desktopMore
}

export function onboardingAgentLabel(
	id: McpClientKind,
	surface: OnboardingAgentSurface = 'desktop',
): string {
	if (id === 'other') return 'Not listed'
	if (surface === 'mobile') {
		switch (id) {
			case 'chatgpt':
				return 'Codex'
			case 'claude-desktop':
				return 'Claude Code'
			case 'copilot-app':
				return 'Copilot'
			case 'grok':
				return 'Grok'
			default:
				break
		}
	}
	return mcpClientById(id).label
}

export function onboardingAgentIconName(
	id: McpClientKind,
	surface: OnboardingAgentSurface = 'desktop',
): string | null {
	if (surface === 'mobile') {
		if (id === 'chatgpt') return 'codex'
		if (id === 'claude-desktop') return 'claudecode'
	}
	switch (id) {
		case 'cursor':
			return 'cursor'
		case 'claude-code':
			return 'claudecode'
		case 'claude-desktop':
			return 'claude'
		case 'chatgpt':
			return 'chatgpt'
		case 'codex':
			return 'codex'
		case 'grok':
		case 'grok-cli':
			return 'grok'
		case 'grok-bot':
			return 'grokbot'
		case 'copilot':
		case 'copilot-app':
			return 'githubcopilot'
		case 'opencode':
			return 'opencode'
		case 'devin':
			return 'devin'
		case 'gemini':
			return 'gemini'
		case 'openclaw':
			return 'openclaw'
		case 'other':
			return null
		default: {
			const exhaustive: never = id
			return exhaustive
		}
	}
}

export const onboardingAgentSearchParam = 'agent'
export const onboardingSurfaceSearchParam = 'surface'

export function isMcpClientKind(
	value: string | null | undefined,
): value is McpClientKind {
	return mcpClientTabs.some((tab) => tab.id === value)
}

export function isOnboardingAgentSurface(
	value: string | null | undefined,
): value is OnboardingAgentSurface {
	return value === 'desktop' || value === 'mobile'
}

export function mcpClientById(id: McpClientKind): McpClientTab {
	const tab = mcpClientTabs.find((candidate) => candidate.id === id)
	if (!tab) {
		throw new Error(`Unknown MCP client ${id}`)
	}
	return tab
}

export function readOnboardingAgentParam(search: string): McpClientKind | null {
	const params = new URLSearchParams(
		search.startsWith('?') ? search.slice(1) : search,
	)
	const value = params.get(onboardingAgentSearchParam)
	return isMcpClientKind(value) ? value : null
}

export function readOnboardingSurfaceParam(
	search: string,
): OnboardingAgentSurface | null {
	const params = new URLSearchParams(
		search.startsWith('?') ? search.slice(1) : search,
	)
	const value = params.get(onboardingSurfaceSearchParam)
	return isOnboardingAgentSurface(value) ? value : null
}

export function writeOnboardingAgentSearch(
	search: string,
	agent: McpClientKind | null,
	surface?: OnboardingAgentSurface | null,
): string {
	const params = new URLSearchParams(
		search.startsWith('?') ? search.slice(1) : search,
	)
	if (agent) {
		params.set(onboardingAgentSearchParam, agent)
		if (surface) params.set(onboardingSurfaceSearchParam, surface)
		else params.delete(onboardingSurfaceSearchParam)
	} else {
		params.delete(onboardingAgentSearchParam)
		params.delete(onboardingSurfaceSearchParam)
	}
	const next = params.toString()
	return next ? `?${next}` : ''
}

export function buildOnboardingAgentHref(input: {
	pathname: string
	search: string
	hash?: string
	agent: McpClientKind | null
	surface?: OnboardingAgentSurface | null
}): string {
	return `${input.pathname}${writeOnboardingAgentSearch(
		input.search,
		input.agent,
		input.surface,
	)}${input.hash ?? ''}`
}

/** Drop picker and step-hash state so those are not a new data load. */
export function onboardingDataHref(href: string): string {
	const url = new URL(href, 'https://kody.local')
	url.searchParams.delete(onboardingAgentSearchParam)
	url.searchParams.delete(onboardingSurfaceSearchParam)
	url.hash = ''
	return `${url.pathname}${url.search}`
}

/** GitHub docs for adding MCP servers in Copilot CLI (also used by the app). */
export const copilotCliMcpGuideUrl =
	'https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers'

/** GitHub docs for MCP in the GitHub Copilot app. */
export const copilotAppCustomizeGuideUrl =
	'https://docs.github.com/en/copilot/how-tos/github-copilot-app/customize-github-copilot-app'

export const chatGptDeveloperModeGuideUrl =
	'https://developers.openai.com/api/docs/guides/developer-mode'

/** Grok.com UI for adding a custom remote MCP connector. */
export const grokConnectorsUrl = 'https://grok.com/connectors'

export const grokCustomMcpGuideUrl = 'https://docs.x.ai/grok/connectors'

/** Grok CLI (`grok`) MCP add / config.toml docs. */
export const grokCliMcpGuideUrl = 'https://docs.x.ai/build/features/mcp-servers'

/** OpenClaw Control UI + CLI docs for adding a remote MCP server. */
export const openClawMcpGuideUrl = 'https://docs.openclaw.ai/tools/mcp'

/** Cursor Marketplace listing for the official Kody plugin (production). */
export const kodyCursorMarketplaceUrl = 'https://cursor.com/marketplace/kody'

/** Cursor chat command shown on the marketplace listing. */
export const kodyCursorAddPluginCommand = '/add-plugin kody'

/** Confirmed Cursor Marketplace plugin id for Kody. */
export const kodyMarketplacePluginId = '56286216'

/** Confirmed Grok Bot one-click add for the official Kody plugin. */
export const grokBotInstallUrl = `grokbot://app/v1/plugin/add?id=${kodyMarketplacePluginId}`

/** Grok Bot sidebar plugin help. */
export const grokBotConnectPluginsUrl =
	'https://cursor.com/help/grok-bot/connect-plugins'

/**
 * Dedicated ChatGPT / Codex connector icon. ChatGPT rejects uploaded icons
 * over 10 KB; `/apple-touch-icon.png` is larger, so onboarding points here.
 */
export const kodyAppIconPath = '/images/kody-app-icon.png'
export const kodyAppIconFilename = kodyAppIconPath.slice(
	kodyAppIconPath.lastIndexOf('/') + 1,
)

/** Square PNG suitable for ChatGPT plugin / connector app icons. */
export function buildKodyAppIconUrl(mcpServerUrl: string) {
	return new URL(kodyAppIconPath, mcpServerUrl).href
}

export const nonCodingAgentNote =
	'Using Kody packages works great with non-coding agents. For creating or editing packages, a coding agent such as Cursor, Claude Code, Codex, Grok CLI, Copilot, OpenCode, or OpenClaw is usually smoother — those hosts can edit files and iterate on code more easily.'

/** Claude Desktop often does not bind MCP tools until the next turn. */
export const claudeDesktopToolHint =
	'After connecting, start a new chat and ask Claude to list Kody tools before the first task. Claude Desktop often does not bind MCP tools until that next turn.'

export const codingAgentPackageHint =
	'Coding agents are the best fit when you want to create or edit Kody packages. Once a package exists, non-coding agents can use it just fine.'

/** Production MCP URL. `@kodycodes/cli install` uses this when `--mcp-url` is omitted. */
export const defaultKodyMcpUrl = 'https://kody.codes/mcp'

/**
 * Copyable Automatic command for every client. Production uses the CLI
 * default; preview and local origins pass `--mcp-url` so install writes
 * this deployment's MCP endpoint.
 */
export function isDefaultKodyMcpUrl(mcpServerUrl: string) {
	return normalizeMcpUrl(mcpServerUrl) === defaultKodyMcpUrl
}

export function buildKodyCliInstallCommand(mcpServerUrl: string) {
	if (isDefaultKodyMcpUrl(mcpServerUrl)) {
		return 'npx @kodycodes/cli install'
	}
	return `npx @kodycodes/cli install --mcp-url ${mcpServerUrl}`
}

function normalizeMcpUrl(mcpServerUrl: string) {
	return mcpServerUrl.replace(/\/+$/u, '')
}

function prettyJson(value: unknown) {
	return `${JSON.stringify(value, null, 2)}\n`
}

/** VS Code protocol handler for installing a remote MCP server. */
export function buildVsCodeInstallUrl(mcpServerUrl: string) {
	const config = encodeURIComponent(
		JSON.stringify({
			name: 'kody',
			type: 'http',
			url: mcpServerUrl,
		}),
	)
	return `vscode:mcp/install?${config}`
}

/** Claude Code project `.mcp.json` or user-scoped `mcpServers` entry. */
export function buildClaudeCodeMcpJson(mcpServerUrl: string) {
	return prettyJson({
		mcpServers: {
			kody: {
				type: 'http',
				url: mcpServerUrl,
			},
		},
	})
}

export function buildClaudeCodeAddCommand(mcpServerUrl: string) {
	return `claude mcp add --transport http -s user kody ${mcpServerUrl}`
}

/** Codex CLI streamable HTTP add. OAuth may need `codex mcp login kody`. */
export function buildCodexMcpAddCommand(mcpServerUrl: string) {
	return `codex mcp add kody --url ${mcpServerUrl}`
}

export const codexMcpLoginCommand = 'codex mcp login kody'

/**
 * OpenCode non-interactive remote add (`opencode mcp add <name> --url`).
 * OAuth may need `opencode mcp auth kody`.
 */
export function buildOpenCodeMcpAddCommand(mcpServerUrl: string) {
	return `opencode mcp add kody --url ${mcpServerUrl}`
}

export const openCodeMcpAuthCommand = 'opencode mcp auth kody'

/**
 * OpenClaw remote Streamable HTTP add. OAuth needs
 * `openclaw mcp login kody` after the definition is saved.
 */
export function buildOpenClawMcpAddCommand(mcpServerUrl: string) {
	return `openclaw mcp add kody --url ${mcpServerUrl} --transport streamable-http --auth oauth`
}

export const openClawMcpLoginCommand = 'openclaw mcp login kody'

export const openClawMcpDoctorCommand = 'openclaw mcp doctor kody --probe'

/** VS Code Copilot `.vscode/mcp.json` (root key is `servers`, not `mcpServers`). */
export function buildVsCodeMcpJson(mcpServerUrl: string) {
	return prettyJson({
		servers: {
			kody: {
				type: 'http',
				url: mcpServerUrl,
			},
		},
	})
}

/** Copilot CLI one-shot remote HTTP add (writes `~/.copilot/mcp-config.json`). */
export function buildCopilotCliAddCommand(mcpServerUrl: string) {
	return `copilot mcp add --transport http kody ${mcpServerUrl}`
}

/**
 * Copilot CLI / Copilot app user config (`~/.copilot/mcp-config.json`).
 * Root key is `mcpServers` — Copilot CLI does not read `.vscode/mcp.json`.
 */
export function buildCopilotCliMcpJson(mcpServerUrl: string) {
	return prettyJson({
		mcpServers: {
			kody: {
				type: 'http',
				url: mcpServerUrl,
			},
		},
	})
}

/** OpenCode `opencode.json` remote server entry. */
export function buildOpenCodeMcpJson(mcpServerUrl: string) {
	return prettyJson({
		mcp: {
			kody: {
				type: 'remote',
				url: mcpServerUrl,
				enabled: true,
			},
		},
	})
}

/** OpenClaw `~/.openclaw/openclaw.json` `mcp.servers` entry. */
export function buildOpenClawMcpJson(mcpServerUrl: string) {
	return prettyJson({
		mcp: {
			servers: {
				kody: {
					url: mcpServerUrl,
					transport: 'streamable-http',
					auth: 'oauth',
					enabled: true,
				},
			},
		},
	})
}

/** Codex shared `~/.codex/config.toml` streamable HTTP entry. */
export function buildCodexMcpToml(mcpServerUrl: string) {
	return [
		'[mcp_servers.kody]',
		`url = ${JSON.stringify(mcpServerUrl)}`,
		'',
	].join('\n')
}

/** Grok CLI one-shot remote HTTP add (writes `~/.grok/config.toml`). */
export function buildGrokCliAddCommand(mcpServerUrl: string) {
	return `grok mcp add --transport http --scope user kody ${mcpServerUrl}`
}

/** Grok CLI user config (`~/.grok/config.toml`) streamable HTTP entry. */
export function buildGrokCliMcpToml(mcpServerUrl: string) {
	return [
		'[mcp_servers.kody]',
		`url = ${JSON.stringify(mcpServerUrl)}`,
		'',
	].join('\n')
}

/**
 * Every copyable snippet the onboarding MCP tabs render. Origin highlights
 * this list once per `mcpServerUrl` and the UI looks tokens up by key.
 */
export function collectOnboardingMcpSnippets(mcpServerUrl: string) {
	return [
		{ code: mcpServerUrl },
		{ code: buildKodyAppIconUrl(mcpServerUrl) },
		{ code: kodyCursorAddPluginCommand },
		{ code: grokBotInstallUrl },
		{ code: buildCodexMcpAddCommand(mcpServerUrl), lang: 'sh' },
		{ code: buildCodexMcpToml(mcpServerUrl), lang: 'toml' },
		{ code: buildGrokCliAddCommand(mcpServerUrl), lang: 'sh' },
		{ code: buildGrokCliMcpToml(mcpServerUrl), lang: 'toml' },
		{ code: buildClaudeCodeAddCommand(mcpServerUrl), lang: 'sh' },
		{ code: buildClaudeCodeMcpJson(mcpServerUrl), lang: 'json' },
		{ code: buildOpenCodeMcpAddCommand(mcpServerUrl), lang: 'sh' },
		{ code: buildOpenCodeMcpJson(mcpServerUrl), lang: 'json' },
		{ code: buildOpenClawMcpAddCommand(mcpServerUrl), lang: 'sh' },
		{ code: buildOpenClawMcpJson(mcpServerUrl), lang: 'json' },
		{ code: openClawMcpLoginCommand, lang: 'sh' },
		{ code: openClawMcpDoctorCommand, lang: 'sh' },
		{ code: buildCopilotCliAddCommand(mcpServerUrl), lang: 'sh' },
		{ code: buildVsCodeMcpJson(mcpServerUrl), lang: 'json' },
		{ code: buildCopilotCliMcpJson(mcpServerUrl), lang: 'json' },
		{ code: buildKodyCliInstallCommand(mcpServerUrl), lang: 'sh' },
	]
}
