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
	chatGptDeveloperModeGuideUrl,
	claudeDesktopToolHint,
	codexMcpLoginCommand,
	codingAgentPackageHint,
	copilotAppCustomizeGuideUrl,
	copilotCliMcpGuideUrl,
	grokBotConnectPluginsUrl,
	grokBotInstallUrl,
	grokCliMcpGuideUrl,
	grokConnectorsUrl,
	grokCustomMcpGuideUrl,
	kodyCursorAddPluginCommand,
	kodyCursorMarketplaceUrl,
	type McpClientKind,
	type OnboardingAgentSurface,
	nonCodingAgentNote,
	openClawMcpDoctorCommand,
	openClawMcpGuideUrl,
	openClawMcpLoginCommand,
	openCodeMcpAuthCommand,
} from '#client/routes/onboarding-mcp-clients.ts'
import { type HighlightedCode } from '#universal/highlighted-code.ts'
import {
	ClientNote,
	CopyCard,
	InstallDeepLink,
	PluginPrimaryInstall,
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
				<>
					<p>
						{surface === 'mobile'
							? 'From your phone, open cursor.com and install the official '
							: 'Install the official '}
						<a
							href={kodyCursorMarketplaceUrl}
							target="_blank"
							rel="noreferrer noopener"
						>
							Kody plugin
						</a>
						{surface === 'mobile'
							? ' so you can kick off and check cloud agents. This is not a full editor on a phone.'
							: ' from the Cursor Marketplace.'}
					</p>
					<PluginPrimaryInstall
						href={kodyCursorMarketplaceUrl}
						label="Add to Cursor"
						alternativeValue={kodyCursorAddPluginCommand}
						alternativeCopyLabel="Copy /add-plugin kody"
					/>
					<ClientNote>{codingAgentPackageHint}</ClientNote>
				</>
			)
		case 'chatgpt': {
			const appIconUrl = buildKodyAppIconUrl(mcpServerUrl)
			return (
				<>
					<p>
						{surface === 'mobile' ? (
							<>
								On your phone, open the <strong>ChatGPT</strong> app and use{' '}
								<strong>Codex</strong>. Turn on <strong>Developer mode</strong>{' '}
								if the app asks for it, then add Kody as a custom app / MCP
								server with this URL. Complete OAuth when prompted.
							</>
						) : (
							<>
								This is <strong>chatgpt.com</strong> (web). ChatGPT desktop is
								Codex — choose Codex instead. On chatgpt.com, turn on{' '}
								<strong>Developer mode</strong> under Settings → Security and
								login. Developer mode is available on the web for{' '}
								<a
									href={chatGptDeveloperModeGuideUrl}
									target="_blank"
									rel="noreferrer noopener"
								>
									eligible paid plans (Plus, Pro, Business, Enterprise, and
									Education)
								</a>
								. In a managed workspace, ask an admin to enable access if the
								setting or Plugins UI is missing. Then open{' '}
								<strong>
									Settings → Plugins → Browse plugins → Create app
								</strong>{' '}
								and paste the MCP URL as the server URL. Complete OAuth when
								prompted.
							</>
						)}
					</p>
					<CopyCard
						highlights={highlights}
						label="MCP URL"
						value={mcpServerUrl}
						copyLabel="Copy MCP URL"
					/>
					<p>
						For the app icon, download Kody&apos;s favicon from the URL below.
						Owners can edit a developer-mode app&apos;s name and logo later from
						its <strong>Manage</strong> menu in Apps settings.
					</p>
					<CopyCard
						highlights={highlights}
						label="App icon (favicon)"
						value={appIconUrl}
						copyLabel="Copy icon URL"
					/>
					<ClientNote>
						{surface === 'mobile' ? codingAgentPackageHint : nonCodingAgentNote}
					</ClientNote>
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
						<p>
							On your phone, open the <strong>ChatGPT</strong> app and use{' '}
							<strong>Codex</strong>. The Codex CLI is for a computer. Add Kody
							as a custom app / MCP server with this URL, then complete OAuth
							when prompted.
						</p>
						<CopyCard
							highlights={highlights}
							label="MCP URL"
							value={mcpServerUrl}
							copyLabel="Copy MCP URL"
						/>
						<CopyCard
							highlights={highlights}
							label="App icon (favicon)"
							value={appIconUrl}
							copyLabel="Copy icon URL"
						/>
						<ClientNote>{codingAgentPackageHint}</ClientNote>
					</>
				)
			}
			return (
				<>
					<p>
						ChatGPT desktop is Codex. It shares{' '}
						<code>~/.codex/config.toml</code> with Codex CLI and the IDE
						extension. Run the Codex CLI, then{' '}
						<code>{codexMcpLoginCommand}</code> if OAuth does not start
						automatically, or add the streamable HTTP entry yourself:
					</p>
					<CopyCard
						highlights={highlights}
						label="codex CLI"
						value={codexCommand}
						copyLabel="Copy command"
						lang="sh"
					/>
					<CopyCard
						highlights={highlights}
						label="config.toml"
						value={codexToml}
						copyLabel="Copy TOML"
						lang="toml"
					/>
					<ClientNote>{codingAgentPackageHint}</ClientNote>
				</>
			)
		}
		case 'claude-desktop':
			return (
				<>
					<p>
						{surface === 'mobile' ? (
							<>
								In the <strong>Claude</strong> app, open{' '}
								<strong>Settings → Connectors</strong>, add a custom connector,
								and paste this MCP URL. That is how Claude Code on your phone
								talks to Kody. Complete OAuth when the app opens it.
							</>
						) : (
							<>
								In Claude Desktop, open <strong>Settings → Connectors</strong>{' '}
								(or Customize → Connectors), add a custom connector, and paste
								this MCP URL. Claude Desktop handles remote OAuth through that
								UI.
							</>
						)}
					</p>
					<CopyCard
						highlights={highlights}
						label="MCP URL"
						value={mcpServerUrl}
						copyLabel="Copy MCP URL"
					/>
					<p>
						Do not put the remote URL into{' '}
						<code>claude_desktop_config.json</code>. After connecting, start a
						new chat and ask Claude to list Kody tools before the first task.
					</p>
					<ClientNote>{claudeDesktopToolHint}</ClientNote>
					<ClientNote>{nonCodingAgentNote}</ClientNote>
				</>
			)
		case 'grok':
			return (
				<>
					<p>
						{surface === 'mobile' ? (
							<>
								On your phone, open the <strong>Grok</strong> app or{' '}
								<a
									href={grokConnectorsUrl}
									target="_blank"
									rel="noreferrer noopener"
								>
									grok.com → Connectors
								</a>
								, add a custom connector, and paste this MCP URL. Complete OAuth
								when Grok prompts you.
							</>
						) : (
							<>
								In{' '}
								<a
									href={grokConnectorsUrl}
									target="_blank"
									rel="noreferrer noopener"
								>
									Grok.com → Connectors
								</a>
								, click <strong>New Connector</strong>, select{' '}
								<strong>Custom</strong>, and paste this MCP URL. Complete OAuth
								when Grok prompts you. For Grok Business and Enterprise, a team
								admin must first add this custom MCP server in the cloud
								console. Members can then connect it from the Grok connectors
								page. See xAI&apos;s{' '}
								<a
									href={grokCustomMcpGuideUrl}
									target="_blank"
									rel="noreferrer noopener"
								>
									custom MCP connector docs
								</a>{' '}
								for details.
							</>
						)}
					</p>
					<CopyCard
						highlights={highlights}
						label="MCP URL"
						value={mcpServerUrl}
						copyLabel="Copy MCP URL"
						variant="pill"
					/>
					<p>
						Grok CLI and Grok Bot are separate products. Change selection if you
						meant one of those instead.
					</p>
					<ClientNote>{nonCodingAgentNote}</ClientNote>
				</>
			)
		case 'grok-cli': {
			const grokCliCommand = buildGrokCliAddCommand(mcpServerUrl)
			const grokCliToml = buildGrokCliMcpToml(mcpServerUrl)
			return (
				<>
					{surface === 'mobile' ? (
						<p>
							Grok CLI is a desktop terminal. On your phone, change selection
							and choose <strong>Grok Bot</strong>, or run these steps later on
							a computer.
						</p>
					) : null}
					<p>
						Add a remote HTTP server (writes <code>~/.grok/config.toml</code>).
						OAuth opens a browser on first use; in the TUI, <code>/mcps</code>{' '}
						then <strong>i</strong> authenticates:
					</p>
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
					<p>
						See xAI&apos;s{' '}
						<a
							href={grokCliMcpGuideUrl}
							target="_blank"
							rel="noreferrer noopener"
						>
							Grok CLI MCP docs
						</a>{' '}
						for <code>grok mcp list</code>, <code>grok mcp doctor</code>, and
						project scope. For grok.com or Grok Bot, change selection and choose
						that host instead.
					</p>
					<ClientNote>{codingAgentPackageHint}</ClientNote>
				</>
			)
		}
		case 'grok-bot':
			return (
				<>
					<p>
						{surface === 'mobile' ? (
							<>
								On your phone, tap <strong>Add to Grok Bot</strong> to install
								the official Kody plugin. If the app is not installed, add Kody
								from <strong>Plugins</strong> in Grok Bot on a computer. This is
								Cursor&apos;s Grok Bot, not grok.com. See{' '}
								<a
									href={grokBotConnectPluginsUrl}
									target="_blank"
									rel="noreferrer noopener"
								>
									Grok Bot plugin help
								</a>
								.
							</>
						) : (
							<>
								Install the official Kody plugin in Grok Bot. Click{' '}
								<strong>Add to Grok Bot</strong>, or open{' '}
								<strong>Plugins</strong> in the Grok Bot sidebar and add Kody.
								See{' '}
								<a
									href={grokBotConnectPluginsUrl}
									target="_blank"
									rel="noreferrer noopener"
								>
									Grok Bot plugin help
								</a>
								.
							</>
						)}
					</p>
					<PluginPrimaryInstall
						href={grokBotInstallUrl}
						label="Add to Grok Bot"
						alternativeValue={grokBotInstallUrl}
						alternativeCopyLabel="Copy Grok Bot plugin link"
					/>
					<p>
						Grok.com (xAI web connectors) and Grok CLI are separate products.
						Change selection if you meant one of those instead.
					</p>
					<ClientNote>{nonCodingAgentNote}</ClientNote>
				</>
			)
		case 'claude-code': {
			const claudeCodeCommand = buildClaudeCodeAddCommand(mcpServerUrl)
			const claudeCodeJson = buildClaudeCodeMcpJson(mcpServerUrl)
			if (surface === 'mobile') {
				return (
					<>
						<p>
							On your phone, open the <strong>Claude</strong> app, go to{' '}
							<strong>Settings → Connectors</strong>, add a custom connector,
							and paste this MCP URL. The Claude Code CLI is for a computer.
							Complete OAuth when the app opens it.
						</p>
						<CopyCard
							highlights={highlights}
							label="MCP URL"
							value={mcpServerUrl}
							copyLabel="Copy MCP URL"
						/>
						<ClientNote>{claudeDesktopToolHint}</ClientNote>
						<ClientNote>{codingAgentPackageHint}</ClientNote>
					</>
				)
			}
			return (
				<>
					<p>
						Run this (user scope, all projects), or merge the JSON into a
						project <code>.mcp.json</code> (or the user-scoped{' '}
						<code>mcpServers</code> block). Claude Code requires{' '}
						<code>type: &quot;http&quot;</code> for remote servers:
					</p>
					<CopyCard
						highlights={highlights}
						label="claude CLI"
						value={claudeCodeCommand}
						copyLabel="Copy command"
						lang="sh"
					/>
					<CopyCard
						highlights={highlights}
						label=".mcp.json"
						value={claudeCodeJson}
						copyLabel="Copy JSON"
						lang="json"
					/>
					<ClientNote>{codingAgentPackageHint}</ClientNote>
				</>
			)
		}
		case 'opencode': {
			const openCodeCommand = buildOpenCodeMcpAddCommand(mcpServerUrl)
			const openCodeJson = buildOpenCodeMcpJson(mcpServerUrl)
			return (
				<>
					{surface === 'mobile' ? (
						<p>
							OpenCode is a desktop terminal. On your phone, change selection
							and pick a host with a mobile app, or run these steps later on a
							computer.
						</p>
					) : null}
					<p>
						Run this to add Kody as a remote MCP server, then{' '}
						<code>{openCodeMcpAuthCommand}</code> if prompted. Or add the remote
						entry to your OpenCode config (<code>opencode.json</code> in the
						project, or your global OpenCode config). OpenCode uses{' '}
						<code>type: &quot;remote&quot;</code>:
					</p>
					<CopyCard
						highlights={highlights}
						label="opencode CLI"
						value={openCodeCommand}
						copyLabel="Copy command"
						lang="sh"
					/>
					<CopyCard
						highlights={highlights}
						label="opencode.json"
						value={openCodeJson}
						copyLabel="Copy JSON"
						lang="json"
					/>
					<ClientNote>{codingAgentPackageHint}</ClientNote>
				</>
			)
		}
		case 'openclaw': {
			const openClawCommand = buildOpenClawMcpAddCommand(mcpServerUrl)
			const openClawJson = buildOpenClawMcpJson(mcpServerUrl)
			return (
				<>
					{surface === 'mobile' ? (
						<p>
							OpenClaw 2&apos;s browser app works from a phone. You can also run
							the CLI later on a computer. Add Kody as a remote Streamable HTTP
							server, then complete OAuth.
						</p>
					) : null}
					<p>
						Run this to add Kody, then <code>{openClawMcpLoginCommand}</code> to
						authorize. <code>{openClawMcpDoctorCommand}</code> proves the server
						answers. Or add the same entry in the Control UI under{' '}
						<strong>Settings → MCP → Add server</strong> (Streamable HTTP), or
						merge it into <code>~/.openclaw/openclaw.json</code>:
					</p>
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
					<CopyCard
						highlights={highlights}
						label="~/.openclaw/openclaw.json"
						value={openClawJson}
						copyLabel="Copy JSON"
						lang="json"
					/>
					<p>
						See OpenClaw&apos;s{' '}
						<a
							href={openClawMcpGuideUrl}
							target="_blank"
							rel="noreferrer noopener"
						>
							MCP docs
						</a>{' '}
						for the Control UI, composer connectors, and{' '}
						<code>doctor --probe</code>.
					</p>
					<ClientNote>{codingAgentPackageHint}</ClientNote>
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
					<>
						<p>
							On your phone, start or watch a Copilot coding agent from the{' '}
							<strong>GitHub</strong> app or the <strong>Copilot</strong> app.
							Add a custom remote MCP server with this URL, then complete OAuth
							when the app opens it.
						</p>
						<CopyCard
							highlights={highlights}
							label="MCP URL"
							value={mcpServerUrl}
							copyLabel="Copy MCP URL"
						/>
						<ClientNote>{codingAgentPackageHint}</ClientNote>
					</>
				)
			}
			return (
				<>
					<p>
						Run this to add a remote HTTP server for Copilot CLI (writes{' '}
						<code>~/.copilot/mcp-config.json</code>). Copilot CLI does not read{' '}
						<code>.vscode/mcp.json</code>:
					</p>
					<CopyCard
						highlights={highlights}
						label="copilot CLI"
						value={copilotCliCommand}
						copyLabel="Copy command"
						lang="sh"
					/>
					<p>
						<strong>In VS Code (Copilot Chat):</strong> install Kody directly,
						create or edit <code>.vscode/mcp.json</code> in your workspace, or
						open user MCP config via the{' '}
						<strong>MCP: Open User Configuration</strong> command. VS Code uses
						the root key <code>servers</code>, not <code>mcpServers</code>. Use
						Agent mode in Copilot Chat so MCP tools are available, then complete
						OAuth when VS Code opens it.
					</p>
					<InstallDeepLink href={installUrl} label="Add to VS Code" />
					<CopyCard
						highlights={highlights}
						label=".vscode/mcp.json"
						value={vsCodeJson}
						copyLabel="Copy JSON"
						lang="json"
					/>
					<p>
						Or merge this into <code>~/.copilot/mcp-config.json</code> (root key{' '}
						<code>mcpServers</code>):
					</p>
					<CopyCard
						highlights={highlights}
						label="~/.copilot/mcp-config.json"
						value={copilotCliJson}
						copyLabel="Copy JSON"
						lang="json"
					/>
					<p>
						See GitHub&apos;s{' '}
						<a
							href={copilotCliMcpGuideUrl}
							target="_blank"
							rel="noreferrer noopener"
						>
							Copilot CLI MCP docs
						</a>{' '}
						for details. The GitHub Copilot app has its own picker entry
						(Copilot App).
					</p>
					<ClientNote>{codingAgentPackageHint}</ClientNote>
				</>
			)
		}
		case 'devin':
			return (
				<>
					<p>
						{surface === 'mobile'
							? 'On your phone, open Devin in the browser, add a custom remote MCP server, and paste this URL. Complete OAuth when Devin opens it.'
							: 'In Devin Desktop, add a custom remote MCP server and paste this URL. Complete OAuth when Devin opens it. The same connector works from the mobile-friendly web app.'}
					</p>
					<CopyCard
						highlights={highlights}
						label="MCP URL"
						value={mcpServerUrl}
						copyLabel="Copy MCP URL"
					/>
					<ClientNote>{codingAgentPackageHint}</ClientNote>
				</>
			)
		case 'gemini':
			return (
				<>
					<p>
						{surface === 'mobile'
							? 'On your phone, open the Gemini app or Jules, add a custom MCP connector, and paste this URL. Complete OAuth when Google prompts you.'
							: 'In the Gemini app or Jules, add a custom MCP connector and paste this URL. Complete OAuth when Google prompts you.'}
					</p>
					<CopyCard
						highlights={highlights}
						label="MCP URL"
						value={mcpServerUrl}
						copyLabel="Copy MCP URL"
					/>
					<ClientNote>{nonCodingAgentNote}</ClientNote>
				</>
			)
		case 'copilot-app': {
			const copilotCliJson = buildCopilotCliMcpJson(mcpServerUrl)
			return (
				<>
					<p>
						{surface === 'mobile' ? (
							<>
								On your phone, open the <strong>GitHub Copilot</strong> app, go
								to settings → <strong>MCP Servers</strong>, add this URL, and
								complete OAuth when the app opens it:
							</>
						) : (
							<>
								In the GitHub Copilot app, open settings and go to{' '}
								<strong>MCP Servers</strong>. Add a custom remote HTTP server
								with this MCP URL, then complete OAuth when the app opens it:
							</>
						)}
					</p>
					<CopyCard
						highlights={highlights}
						label="MCP URL"
						value={mcpServerUrl}
						copyLabel="Copy MCP URL"
					/>
					{surface === 'mobile' ? null : (
						<>
							<p>
								Servers you already configured for Copilot CLI (or in a
								repository) are also available in the app. You can merge this
								into <code>~/.copilot/mcp-config.json</code> instead:
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
					<p>
						See GitHub&apos;s{' '}
						<a
							href={copilotAppCustomizeGuideUrl}
							target="_blank"
							rel="noreferrer noopener"
						>
							Copilot app customization docs
						</a>{' '}
						for MCP Servers, skills, and plugins.
					</p>
					<ClientNote>{nonCodingAgentNote}</ClientNote>
				</>
			)
		}
		case 'other':
			return (
				<>
					<p>
						Any MCP-capable host that supports remote / streamable HTTP servers
						can connect to Kody. Add a remote MCP server pointed at this URL and
						complete the OAuth flow when the host opens it:
					</p>
					<CopyCard
						highlights={highlights}
						label="MCP URL"
						value={mcpServerUrl}
						copyLabel="Copy MCP URL"
					/>
					<p>
						Config file shapes differ by host. If your client expects a JSON{' '}
						<code>mcpServers</code> map with a <code>url</code> field, start
						from the Copilot CLI snippet; if it uses <code>servers</code> with{' '}
						<code>type: &quot;http&quot;</code>, use the Copilot (VS Code)
						snippet.
					</p>
				</>
			)
		default: {
			const exhaustive: never = kind
			return exhaustive
		}
	}
}
