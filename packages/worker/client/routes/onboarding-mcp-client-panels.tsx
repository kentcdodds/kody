import { type Handle } from 'remix/ui'
import {
	buildClaudeCodeAddCommand,
	buildClaudeCodeMcpJson,
	buildCodexMcpAddCommand,
	buildCodexMcpDeepLink,
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
	buildMuseSettingsJson,
	buildVsCodeInstallUrl,
	buildVsCodeMcpJson,
	chatGptDeveloperModeGuideUrl,
	claudeDesktopToolHint,
	grokBotInstallUrl,
	grokConnectorsUrl,
	isDefaultKodyMcpUrl,
	kodyAppIconFilename,
	kodyChatGptPluginUrl,
	kodyCursorAddPluginCommand,
	kodyCursorMarketplaceUrl,
	type McpClientKind,
	type OnboardingAgentSurface,
	museMcpGuideUrl,
	museMcpLoginCommand,
	openClawMcpLoginCommand,
} from '#client/routes/onboarding-mcp-clients.ts'
import { type HighlightedCode } from '#universal/highlighted-code.ts'
import {
	AppIconCard,
	ChatGptDeveloperModeWarning,
	ClientWarning,
	CopyCard,
	CopyCardDetails,
	InstallDeepLink,
	OnboardingManualDetails,
	PluginPrimaryInstall,
	PrimaryActionLink,
} from './onboarding-mcp-client-cards.tsx'

function ConnectCopyCard(
	handle: Handle<{
		label: string
		value: string
		copyLabel: string
		variant?: 'pill' | 'ghost'
		lang?: string | null
		highlights?: Record<string, HighlightedCode>
	}>,
) {
	return () => (
		<CopyCard
			highlights={handle.props.highlights}
			label={handle.props.label}
			value={handle.props.value}
			copyLabel={handle.props.copyLabel}
			variant={handle.props.variant}
			lang={handle.props.lang}
			signalsConnectAction
		/>
	)
}

function ConnectCopyCardDetails(
	handle: Handle<{
		label: string
		value: string
		copyLabel: string
		summaryLead: string
		summaryCode?: string
		variant?: 'pill' | 'ghost'
		lang?: string | null
		highlights?: Record<string, HighlightedCode>
	}>,
) {
	return () => (
		<CopyCardDetails
			highlights={handle.props.highlights}
			summaryLead={handle.props.summaryLead}
			summaryCode={handle.props.summaryCode}
			label={handle.props.label}
			value={handle.props.value}
			copyLabel={handle.props.copyLabel}
			variant={handle.props.variant}
			lang={handle.props.lang}
			signalsConnectAction
		/>
	)
}

function ChatGptPluginAction(_handle: Handle<object>) {
	return () => (
		<PrimaryActionLink
			href={kodyChatGptPluginUrl}
			label="Add ChatGPT plugin"
			external
		/>
	)
}

export function renderPanelContent(
	kind: McpClientKind,
	mcpServerUrl: string,
	highlights?: Record<string, HighlightedCode>,
	surface: OnboardingAgentSurface = 'desktop',
) {
	switch (kind) {
		case 'cursor':
		case 'cursor-local':
		case 'cursor-cloud':
			return (
				<PluginPrimaryInstall
					href={kodyCursorMarketplaceUrl}
					label={
						kind === 'cursor-cloud'
							? 'Add to Cursor Cloud'
							: kind === 'cursor-local'
								? 'Add to Cursor Local'
								: 'Add to Cursor'
					}
					alternativeValue={kodyCursorAddPluginCommand}
					alternativeCopyLabel="Copy /add-plugin kody"
				/>
			)
		case 'chatgpt': {
			const appIconUrl = buildKodyAppIconUrl(mcpServerUrl)
			const developerApp = (
				<>
					<ConnectCopyCard
						highlights={highlights}
						label="MCP URL"
						value={mcpServerUrl}
						copyLabel="Copy MCP URL"
					/>
					<AppIconCard src={appIconUrl} downloadName={kodyAppIconFilename} />
					<ChatGptDeveloperModeWarning
						href={chatGptDeveloperModeGuideUrl}
						linkLabel="developer mode help"
					/>
				</>
			)
			if (!isDefaultKodyMcpUrl(mcpServerUrl)) return developerApp
			return (
				<>
					<ChatGptPluginAction />
					<OnboardingManualDetails summaryLead="Or create a developer-mode app">
						{developerApp}
					</OnboardingManualDetails>
				</>
			)
		}
		case 'codex': {
			const appIconUrl = buildKodyAppIconUrl(mcpServerUrl)
			const codexDeepLink = buildCodexMcpDeepLink(mcpServerUrl)
			const codexCommand = buildCodexMcpAddCommand(mcpServerUrl)
			const codexToml = buildCodexMcpToml(mcpServerUrl)
			if (surface === 'mobile') {
				const mobileMcp = (
					<>
						<ConnectCopyCard
							highlights={highlights}
							label="MCP URL"
							value={mcpServerUrl}
							copyLabel="Copy MCP URL"
						/>
						<AppIconCard src={appIconUrl} downloadName={kodyAppIconFilename} />
					</>
				)
				if (!isDefaultKodyMcpUrl(mcpServerUrl)) return mobileMcp
				return (
					<>
						<ChatGptPluginAction />
						<OnboardingManualDetails summaryLead="Or paste the MCP URL in the ChatGPT app">
							{mobileMcp}
						</OnboardingManualDetails>
					</>
				)
			}
			const desktopMcp = (
				<>
					<PrimaryActionLink href={codexDeepLink} label="Open Codex" />
					<ConnectCopyCard
						highlights={highlights}
						label="codex CLI"
						value={codexCommand}
						copyLabel="Copy command"
						variant="pill"
						lang="sh"
					/>
					<ConnectCopyCard
						highlights={highlights}
						label="~/.codex/config.toml"
						value={codexToml}
						copyLabel="Copy TOML"
						lang="toml"
					/>
				</>
			)
			if (!isDefaultKodyMcpUrl(mcpServerUrl)) return desktopMcp
			return (
				<>
					<ChatGptPluginAction />
					<OnboardingManualDetails summaryLead="Or add Kody as a Codex MCP server">
						{desktopMcp}
					</OnboardingManualDetails>
				</>
			)
		}
		case 'claude-desktop':
			return (
				<ConnectCopyCard
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
					<ConnectCopyCard
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
					<ConnectCopyCard
						highlights={highlights}
						label="grok CLI"
						value={grokCliCommand}
						copyLabel="Copy command"
						variant="pill"
						lang="sh"
					/>
					<ConnectCopyCardDetails
						highlights={highlights}
						summaryLead="Or merge this into"
						summaryCode="~/.grok/config.toml"
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
					<ConnectCopyCard
						highlights={highlights}
						label="MCP URL"
						value={mcpServerUrl}
						copyLabel="Copy MCP URL"
					/>
				)
			}
			return (
				<>
					<ConnectCopyCard
						highlights={highlights}
						label="claude CLI"
						value={claudeCodeCommand}
						copyLabel="Copy command"
						lang="sh"
					/>
					<ConnectCopyCardDetails
						highlights={highlights}
						summaryLead="Or merge this into a project"
						summaryCode=".mcp.json"
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
					<ConnectCopyCard
						highlights={highlights}
						label="opencode CLI"
						value={openCodeCommand}
						copyLabel="Copy command"
						lang="sh"
					/>
					<ConnectCopyCardDetails
						highlights={highlights}
						summaryLead="Or add this to"
						summaryCode="opencode.json"
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
					<ConnectCopyCard
						highlights={highlights}
						label="openclaw CLI"
						value={openClawCommand}
						copyLabel="Copy command"
						lang="sh"
					/>
					<ConnectCopyCard
						highlights={highlights}
						label="openclaw mcp login"
						value={openClawMcpLoginCommand}
						copyLabel="Copy command"
						lang="sh"
					/>
					<ConnectCopyCardDetails
						highlights={highlights}
						summaryLead="Or merge this into"
						summaryCode="~/.openclaw/openclaw.json"
						label="~/.openclaw/openclaw.json"
						value={openClawJson}
						copyLabel="Copy JSON"
						lang="json"
					/>
				</>
			)
		}
		case 'muse': {
			const museSettingsJson = buildMuseSettingsJson(mcpServerUrl)
			return (
				<>
					<p>
						Add Kody to Muse Code via <code>~/.config/muse/settings.json</code>,
						then sign in with <code>muse mcp login</code> (
						<a href={museMcpGuideUrl} target="_blank" rel="noreferrer">
							Muse MCP docs
						</a>
						).
					</p>
					<ConnectCopyCardDetails
						highlights={highlights}
						summaryLead="Merge into"
						summaryCode="~/.config/muse/settings.json"
						label="~/.config/muse/settings.json"
						value={museSettingsJson}
						copyLabel="Copy JSON"
						variant="pill"
						lang="json"
					/>
					<ConnectCopyCard
						highlights={highlights}
						label="muse mcp login"
						value={museMcpLoginCommand}
						copyLabel="Copy command"
						variant="pill"
						lang="sh"
					/>
					<p>
						After OAuth succeeds, headless Muse may ask you to paste a localhost
						URL into the Muse chat.
					</p>
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
					<ConnectCopyCard
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
					<ConnectCopyCard
						highlights={highlights}
						label="copilot CLI"
						value={copilotCliCommand}
						copyLabel="Copy command"
						lang="sh"
					/>
					<ConnectCopyCardDetails
						highlights={highlights}
						summaryLead="Or merge this into"
						summaryCode=".vscode/mcp.json"
						label=".vscode/mcp.json"
						value={vsCodeJson}
						copyLabel="Copy JSON"
						lang="json"
					/>
					<ConnectCopyCardDetails
						highlights={highlights}
						summaryLead="Or merge this into"
						summaryCode="~/.copilot/mcp-config.json"
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
				<ConnectCopyCard
					highlights={highlights}
					label="MCP URL"
					value={mcpServerUrl}
					copyLabel="Copy MCP URL"
				/>
			)
		case 'gemini':
			return (
				<ConnectCopyCard
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
					<ConnectCopyCard
						highlights={highlights}
						label="MCP URL"
						value={mcpServerUrl}
						copyLabel="Copy MCP URL"
					/>
					{surface === 'mobile' ? null : (
						<>
							<ConnectCopyCardDetails
								highlights={highlights}
								summaryLead="Or merge this into"
								summaryCode="~/.copilot/mcp-config.json"
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
				<ConnectCopyCard
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
		case 'cursor-local':
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
		case 'muse':
			return (
				<ClientWarning>
					{surface === 'mobile'
						? "Muse Code is for a computer. Change selection and pick a host with a mobile app, or run these steps later on a computer. Do not paste npx @kodycodes/cli install into Muse chat — that runs in Muse's Linux VM and cannot configure Muse."
						: "Do not paste npx @kodycodes/cli install into Muse chat — that runs in Muse's Linux VM and cannot configure Muse."}
				</ClientWarning>
			)
		case 'cursor-cloud':
		case 'copilot':
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
