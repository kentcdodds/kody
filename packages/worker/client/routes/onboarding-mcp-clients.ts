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
	| 'vscode'
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
	{ id: 'vscode', label: 'VS Code', isNonCodingAgent: false },
	{ id: 'other', label: 'Other', isNonCodingAgent: false },
] as const satisfies ReadonlyArray<McpClientTab>

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
	'Using Kody packages works great with non-coding agents. For creating or editing packages, a coding agent such as Cursor, Claude Code, Codex, VS Code, or OpenCode is usually smoother — those hosts can edit files and iterate on code more easily.'

export const codingAgentPackageHint =
	'Coding agents are the best fit when you want to create or edit Kody packages. Once a package exists, non-coding agents can use it just fine.'

function prettyJson(value: unknown) {
	return `${JSON.stringify(value, null, 2)}\n`
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
