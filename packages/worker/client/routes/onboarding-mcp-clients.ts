/**
 * Per-client MCP setup snippets and copy for the onboarding page.
 * Keep this module free of Remix/UI so config builders stay unit-testable.
 */

export type McpClientKind =
	| 'cursor'
	| 'chatgpt'
	| 'codex'
	| 'claude-desktop'
	| 'grok'
	| 'claude-code'
	| 'opencode'
	| 'copilot'
	| 'copilot-app'
	| 'other'

export type McpClientTab = {
	id: McpClientKind
	label: string
	/** True for hosts that are primarily chat/non-coding agents. */
	isNonCodingAgent: boolean
}

export const mcpClientTabs = [
	{ id: 'cursor', label: 'Cursor', isNonCodingAgent: false },
	{ id: 'chatgpt', label: 'ChatGPT', isNonCodingAgent: true },
	{ id: 'codex', label: 'Codex', isNonCodingAgent: false },
	{ id: 'claude-desktop', label: 'Claude Desktop', isNonCodingAgent: true },
	{ id: 'grok', label: 'Grok', isNonCodingAgent: true },
	{ id: 'claude-code', label: 'Claude Code', isNonCodingAgent: false },
	{ id: 'opencode', label: 'OpenCode', isNonCodingAgent: false },
	{ id: 'copilot', label: 'Copilot', isNonCodingAgent: false },
	{ id: 'copilot-app', label: 'Copilot App', isNonCodingAgent: true },
	{ id: 'other', label: 'Other', isNonCodingAgent: false },
] as const satisfies ReadonlyArray<McpClientTab>

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

/** Square favicon suitable for ChatGPT plugin / connector app icons. */
export function buildKodyAppIconUrl(mcpServerUrl: string) {
	return new URL('/apple-touch-icon.png', mcpServerUrl).href
}

export const nonCodingAgentNote =
	'Using Kody packages works great with non-coding agents. For creating or editing packages, a coding agent such as Cursor, Claude Code, Codex, Copilot, or OpenCode is usually smoother — those hosts can edit files and iterate on code more easily.'

export const codingAgentPackageHint =
	'Coding agents are the best fit when you want to create or edit Kody packages. Once a package exists, non-coding agents can use it just fine.'

function prettyJson(value: unknown) {
	return `${JSON.stringify(value, null, 2)}\n`
}

function encodeBase64Url(value: string) {
	return btoa(value)
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/u, '')
}

/** Cursor protocol handler for installing a remote MCP server. */
export function buildCursorInstallUrl(mcpServerUrl: string) {
	const config = encodeBase64Url(JSON.stringify({ url: mcpServerUrl }))
	return `cursor://anysphere.cursor-deeplink/mcp/install?name=kody&config=${config}`
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

/** Cursor `~/.cursor/mcp.json` or `.cursor/mcp.json` remote server entry. */
export function buildCursorMcpJson(mcpServerUrl: string) {
	return prettyJson({
		mcpServers: {
			kody: {
				url: mcpServerUrl,
			},
		},
	})
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

/** Codex shared `~/.codex/config.toml` streamable HTTP entry. */
export function buildCodexMcpToml(mcpServerUrl: string) {
	return [
		'[mcp_servers.kody]',
		`url = ${JSON.stringify(mcpServerUrl)}`,
		'',
	].join('\n')
}
