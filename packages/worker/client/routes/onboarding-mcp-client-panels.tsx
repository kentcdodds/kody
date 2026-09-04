import {
	buildClaudeCodeAddCommand,
	buildClaudeCodeMcpJson,
	buildCodexMcpAddCommand,
	buildCodexMcpToml,
	buildCopilotCliAddCommand,
	buildCopilotCliMcpJson,
	buildGrokCliAddCommand,
	buildGrokCliMcpToml,
	buildKodyAppIconUrl,
	buildOpenClawMcpAddCommand,
	buildOpenClawMcpJson,
	buildOpenCodeMcpAddCommand,
	buildOpenCodeMcpJson,
	buildVsCodeInstallUrl,
	buildVsCodeMcpJson,
	claudeDesktopToolHint,
	grokBotInstallUrl,
	grokConnectorsUrl,
	kodyAppIconFilename,
	kodyCursorAddPluginCommand,
	kodyCursorMarketplaceUrl,
	type McpClientKind,
	type OnboardingAgentSurface,
	openClawMcpLoginCommand,
} from '#client/routes/onboarding-mcp-clients.ts'
import { type HighlightedCode } from '#universal/highlighted-code.ts'
import {
	AppIconCard,
	ClientWarning,
	CopyCard,
	InstallDeepLink,
	PluginPrimaryInstall,
	PrimaryActionLink,
} from './onboarding-mcp-client-cards.tsx'

export function renderPanelContent(
	kind: McpClientKind,
	mcpServerUrl: string,
	highlights?: Record<string, HighlightedCode>,
	surface: OnboardingAgentSurface = 'desktop',
) {
	switch (kind) {
		case 'cursor':
			return (
				<PluginPrimaryInstall
					href={kodyCursorMarketplaceUrl}
					label="Add to Cursor"
					alternativeValue={kodyCursorAddPluginCommand}
					alternativeCopyLabel="Copy /add-plugin kody"
				/>
			)
		case 'chatgpt': {
			const appIconUrl = buildKodyAppIconUrl(mcpServerUrl)
			return (
				<>
					<CopyCard
						highlights={highlights}
						label="MCP URL"
						value={mcpServerUrl}
						copyLabel="Copy MCP URL"
					/>
					<AppIconCard src={appIconUrl} downloadName={kodyAppIconFilename} />
				</>
			)
		}
		case 'codex': {
			const appIconUrl = buildKodyAppIconUrl(mcpServerUrl)
			const codexCommand = buildCodexMcpAddCommand(mcpServerUrl)
			const codexToml = buildCodexMcpToml(mcpServerUrl)
			if (surface === 'mobile') {
				return (
					<>
						<CopyCard
							highlights={highlights}
							label="MCP URL"
							value={mcpServerUrl}
							copyLabel="Copy MCP URL"
						/>
						<AppIconCard src={appIconUrl} downloadName={kodyAppIconFilename} />
					</>
				)
			}
			return (
				<>
					<CopyCard
						highlights={highlights}
						label="codex CLI"
						value={codexCommand}
						copyLabel="Copy command"
						lang="sh"
					/>
					<p>
						Or merge this into <code>~/.codex/config.toml</code>:
					</p>
					<CopyCard
						highlights={highlights}
						label="config.toml"
						value={codexToml}
						copyLabel="Copy TOML"
						lang="toml"
					/>
				</>
			)
		}
		case 'claude-desktop':
			return (
				<CopyCard
					highlights={highlights}
					label="MCP URL"
					value={mcpServerUrl}
					copyLabel="Copy MCP URL"
				/>
			)
		case 'grok':
			return (
				<>
					<PrimaryActionLink
						href={grokConnectorsUrl}
						label="Open Connectors"
						external
					/>
					<CopyCard
						highlights={highlights}
						label="MCP URL"
						value={mcpServerUrl}
						copyLabel="Copy MCP URL"
						variant="pill"
					/>
				</>
			)
		case 'grok-cli': {
			const grokCliCommand = buildGrokCliAddCommand(mcpServerUrl)
			const grokCliToml = buildGrokCliMcpToml(mcpServerUrl)
			return (
				<>
					<CopyCard
						highlights={highlights}
						label="grok CLI"
						value={grokCliCommand}
						copyLabel="Copy command"
						variant="pill"
						lang="sh"
					/>
					<p>
						Or merge this into <code>~/.grok/config.toml</code>:
					</p>
					<CopyCard
						highlights={highlights}
						label="~/.grok/config.toml"
						value={grokCliToml}
						copyLabel="Copy TOML"
						lang="toml"
					/>
				</>
			)
		}
		case 'grok-bot':
			return (
				<>
					<PluginPrimaryInstall
						href={grokBotInstallUrl}
						label="Add to Grok Bot"
					/>
					<p>
						{surface === 'mobile' ? (
							<>
								Or add Kody from <strong>Plugins</strong> on a computer.
							</>
						) : (
							<>
								Or add Kody from <strong>Plugins</strong> in the Grok Bot
								sidebar.
							</>
						)}
					</p>
				</>
			)
		case 'claude-code': {
			const claudeCodeCommand = buildClaudeCodeAddCommand(mcpServerUrl)
			const claudeCodeJson = buildClaudeCodeMcpJson(mcpServerUrl)
			if (surface === 'mobile') {
				return (
					<CopyCard
						highlights={highlights}
						label="MCP URL"
						value={mcpServerUrl}
						copyLabel="Copy MCP URL"
					/>
				)
			}
			return (
				<>
					<CopyCard
						highlights={highlights}
						label="claude CLI"
						value={claudeCodeCommand}
						copyLabel="Copy command"
						lang="sh"
					/>
					<p>
						Or merge this into a project <code>.mcp.json</code>:
					</p>
					<CopyCard
						highlights={highlights}
						label=".mcp.json"
						value={claudeCodeJson}
						copyLabel="Copy JSON"
						lang="json"
					/>
				</>
			)
		}
		case 'opencode': {
			const openCodeCommand = buildOpenCodeMcpAddCommand(mcpServerUrl)
			const openCodeJson = buildOpenCodeMcpJson(mcpServerUrl)
			return (
				<>
					<CopyCard
						highlights={highlights}
						label="opencode CLI"
						value={openCodeCommand}
						copyLabel="Copy command"
						lang="sh"
					/>
					<p>
						Or add this to <code>opencode.json</code>:
					</p>
					<CopyCard
						highlights={highlights}
						label="opencode.json"
						value={openCodeJson}
						copyLabel="Copy JSON"
						lang="json"
					/>
				</>
			)
		}
		case 'openclaw': {
			const openClawCommand = buildOpenClawMcpAddCommand(mcpServerUrl)
			const openClawJson = buildOpenClawMcpJson(mcpServerUrl)
			return (
				<>
					<CopyCard
						highlights={highlights}
						label="openclaw CLI"
						value={openClawCommand}
						copyLabel="Copy command"
						lang="sh"
					/>
					<CopyCard
						highlights={highlights}
						label="openclaw mcp login"
						value={openClawMcpLoginCommand}
						copyLabel="Copy command"
						lang="sh"
					/>
					<p>
						Or merge this into <code>~/.openclaw/openclaw.json</code>:
					</p>
					<CopyCard
						highlights={highlights}
						label="~/.openclaw/openclaw.json"
						value={openClawJson}
						copyLabel="Copy JSON"
						lang="json"
					/>
				</>
			)
		}
		case 'copilot': {
			const vsCodeJson = buildVsCodeMcpJson(mcpServerUrl)
			const installUrl = buildVsCodeInstallUrl(mcpServerUrl)
			const copilotCliCommand = buildCopilotCliAddCommand(mcpServerUrl)
			const copilotCliJson = buildCopilotCliMcpJson(mcpServerUrl)
			if (surface === 'mobile') {
				return (
					<CopyCard
						highlights={highlights}
						label="MCP URL"
						value={mcpServerUrl}
						copyLabel="Copy MCP URL"
					/>
				)
			}
			return (
				<>
					<InstallDeepLink href={installUrl} label="Add to VS Code" />
					<p>Or run this for Copilot CLI:</p>
					<CopyCard
						highlights={highlights}
						label="copilot CLI"
						value={copilotCliCommand}
						copyLabel="Copy command"
						lang="sh"
					/>
					<p>
						Or merge this into <code>.vscode/mcp.json</code>:
					</p>
					<CopyCard
						highlights={highlights}
						label=".vscode/mcp.json"
						value={vsCodeJson}
						copyLabel="Copy JSON"
						lang="json"
					/>
					<p>
						Or merge this into <code>~/.copilot/mcp-config.json</code>:
					</p>
					<CopyCard
						highlights={highlights}
						label="~/.copilot/mcp-config.json"
						value={copilotCliJson}
						copyLabel="Copy JSON"
						lang="json"
					/>
				</>
			)
		}
		case 'devin':
			return (
				<CopyCard
					highlights={highlights}
					label="MCP URL"
					value={mcpServerUrl}
					copyLabel="Copy MCP URL"
				/>
			)
		case 'gemini':
			return (
				<CopyCard
					highlights={highlights}
					label="MCP URL"
					value={mcpServerUrl}
					copyLabel="Copy MCP URL"
				/>
			)
		case 'copilot-app': {
			const copilotCliJson = buildCopilotCliMcpJson(mcpServerUrl)
			return (
				<>
					<CopyCard
						highlights={highlights}
						label="MCP URL"
						value={mcpServerUrl}
						copyLabel="Copy MCP URL"
					/>
					{surface === 'mobile' ? null : (
						<>
							<p>
								Or merge this into <code>~/.copilot/mcp-config.json</code>:
							</p>
							<CopyCard
								highlights={highlights}
								label="~/.copilot/mcp-config.json"
								value={copilotCliJson}
								copyLabel="Copy JSON"
								lang="json"
							/>
						</>
					)}
				</>
			)
		}
		case 'other':
			return (
				<CopyCard
					highlights={highlights}
					label="MCP URL"
					value={mcpServerUrl}
					copyLabel="Copy MCP URL"
				/>
			)
		default: {
			const exhaustive: never = kind
			return exhaustive
		}
	}
}

export function renderPanelWarning(
	kind: McpClientKind,
	surface: OnboardingAgentSurface = 'desktop',
) {
	switch (kind) {
		case 'cursor':
			return surface === 'mobile' ? (
				<ClientWarning>
					This is not a full editor on a phone. Open cursor.com to kick off and
					check cloud agents.
				</ClientWarning>
			) : null
		case 'chatgpt':
			return surface === 'mobile' ? null : (
				<ClientWarning>
					ChatGPT desktop is Codex. Change selection if you meant that instead.
				</ClientWarning>
			)
		case 'codex':
			return surface === 'mobile' ? (
				<ClientWarning>
					The Codex CLI is for a computer. This URL is for Codex in the ChatGPT
					app.
				</ClientWarning>
			) : null
		case 'claude-desktop':
			return (
				<ClientWarning>
					{`Do not put the remote URL into claude_desktop_config.json. ${claudeDesktopToolHint}`}
				</ClientWarning>
			)
		case 'grok':
			return (
				<ClientWarning>
					Grok CLI and Grok Bot are separate products. Change selection if you
					meant one of those instead.
				</ClientWarning>
			)
		case 'grok-cli':
			return (
				<ClientWarning>
					{surface === 'mobile'
						? 'Grok CLI is a desktop terminal. Change selection and choose Grok Bot, or run these steps later on a computer. Grok.com and Grok Bot are separate products. Change selection if you meant one of those instead.'
						: 'Grok.com and Grok Bot are separate products. Change selection if you meant one of those instead.'}
				</ClientWarning>
			)
		case 'claude-code':
			return surface === 'mobile' ? (
				<ClientWarning>
					The Claude Code CLI is for a computer. This URL is for the Claude app.
				</ClientWarning>
			) : null
		case 'opencode':
			return surface === 'mobile' ? (
				<ClientWarning>
					OpenCode is a desktop terminal. Change selection and pick a host with
					a mobile app, or run these steps later on a computer.
				</ClientWarning>
			) : null
		case 'openclaw':
			return surface === 'mobile' ? (
				<ClientWarning>
					OpenClaw&apos;s browser app works from a phone. You can also run the
					CLI later on a computer.
				</ClientWarning>
			) : null
		case 'copilot':
			return surface === 'mobile' ? null : (
				<ClientWarning>
					The GitHub Copilot app has its own picker entry (Copilot App).
				</ClientWarning>
			)
		case 'copilot-app':
		case 'devin':
		case 'gemini':
		case 'grok-bot':
		case 'other':
			return null
		default: {
			const exhaustive: never = kind
			return exhaustive
		}
	}
}
