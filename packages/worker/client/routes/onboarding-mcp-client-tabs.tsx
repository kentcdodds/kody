import { type Handle, css } from 'remix/ui'
import { CopyTextButton } from '#client/copy-text-button.tsx'
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
	type OnboardingAgentChooserPick,
	type OnboardingAgentSurface,
	buildOnboardingAgentHref,
	canonicalOnboardingAgentChooser,
	nonCodingAgentNote,
	onboardingAgentIconName,
	onboardingAgentLabel,
	onboardingFeaturedIdsFromChooser,
	onboardingMobileAgentMq,
	onboardingMoreIdsFromChooser,
	openClawMcpDoctorCommand,
	openClawMcpGuideUrl,
	openClawMcpLoginCommand,
	openCodeMcpAuthCommand,
} from '#client/routes/onboarding-mcp-clients.ts'
import {
	colors,
	radius,
	transitions,
	typography,
} from '#universal/styles/tokens.ts'
import {
	getAccentCalloutCss,
	getGhostButtonCss,
	getLogoWellCss,
	getPillButtonCss,
	hoverMq,
} from '#universal/styles/style-primitives.ts'
import { renderHighlightedCode } from '#client/syntax-highlight.tsx'
import {
	highlightSnippetKey,
	plainHighlightedCode,
	type HighlightedCode,
} from '#universal/highlighted-code.ts'

type OnboardingAgentLocation = {
	pathname: string
	search: string
	hash: string
}

type OnboardingMcpClientTabsProps = {
	mcpServerUrl: string
	highlights?: Record<string, HighlightedCode>
	selectedAgent?: McpClientKind | null
	surface?: OnboardingAgentSurface
	chooser?: OnboardingAgentChooserPick | null
	agentLocation?: OnboardingAgentLocation
}

type CopyCardProps = {
	label: string
	value: string
	copyLabel: string
	variant?: 'pill' | 'ghost'
	lang?: string | null
	highlights?: Record<string, HighlightedCode>
}

/**
 * Config snippet, ported from the prototype's `.snippet`: a labeled well on
 * the page ground with an uppercase display-face label and its copy button in
 * the header row. `pill` maps to the redesign's green pill; `ghost` is the
 * default and stays the quiet bordered button for follow-up copies.
 */
function CopyCard(handle: Handle<CopyCardProps>) {
	return () => (
		<div mix={css(snippetCss)}>
			<div mix={css(snippetHeadCss)}>
				<span mix={css(snippetLabelCss)}>{handle.props.label}</span>
				<div mix={css(snippetActionCss)}>
					<CopyTextButton
						value={handle.props.value}
						idleLabel={handle.props.copyLabel}
						variant={handle.props.variant ?? 'ghost'}
					/>
				</div>
			</div>
			<div mix={css(snippetPreCss)}>
				{renderHighlightedCode(
					handle.props.highlights?.[
						highlightSnippetKey({
							code: handle.props.value,
							lang: handle.props.lang,
						})
					] ?? plainHighlightedCode(handle.props.value, handle.props.lang),
				)}
			</div>
		</div>
	)
}

type ClientNoteProps = {
	children: string
}

/* Host-fit aside: a footnote, not a warning — the filled green well stays
   reserved for the one-time-authorization callout. */
function ClientNote(handle: Handle<ClientNoteProps>) {
	return () => (
		<p mix={css(clientNoteCss)} role="note">
			{handle.props.children}
		</p>
	)
}

function InstallDeepLink(
	handle: Handle<{
		href: string
		label: 'Add to Cursor' | 'Add to VS Code'
	}>,
) {
	return () => (
		<div mix={css(deepLinkCss)}>
			<a href={handle.props.href} mix={css(deepLinkButtonCss)}>
				{handle.props.label}
			</a>
			<small mix={css(deepLinkNoteCss)}>
				Your client will still ask you to authorize access afterwards.
			</small>
		</div>
	)
}

function PluginPrimaryInstall(
	handle: Handle<{
		href: string
		label: 'Add to Cursor' | 'Add to Grok Bot'
		alternativeValue: string
		alternativeCopyLabel: string
	}>,
) {
	return () => (
		<div data-testid="onboarding-mcp-plugin-primary" mix={css(deepLinkCss)}>
			<a href={handle.props.href} mix={css(deepLinkButtonCss)}>
				{handle.props.label}
			</a>
			<p
				data-testid="onboarding-mcp-plugin-alternative"
				mix={css(pluginAlternativeCss)}
			>
				Or do this: <code>{handle.props.alternativeValue}</code>
				<CopyTextButton
					value={handle.props.alternativeValue}
					idleLabel="Copy"
					variant="chip"
					ariaLabel={handle.props.alternativeCopyLabel}
				/>
			</p>
			<small mix={css(deepLinkNoteCss)}>
				Your client will still ask you to authorize access afterwards.
			</small>
		</div>
	)
}

function renderPanelContent(
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

function pickerLabel(id: McpClientKind, surface: OnboardingAgentSurface) {
	return onboardingAgentLabel(id, surface)
}

function AgentPickerMark(
	handle: Handle<{ agent: McpClientKind; surface: OnboardingAgentSurface }>,
) {
	return () => {
		const icon = onboardingAgentIconName(
			handle.props.agent,
			handle.props.surface,
		)
		if (!icon) {
			return (
				<span mix={css(pickerMarkCss)} aria-hidden="true">
					<svg
						viewBox="0 0 24 24"
						width="22"
						height="22"
						fill="currentColor"
						aria-hidden="true"
					>
						<circle cx="6" cy="12" r="1.6" />
						<circle cx="12" cy="12" r="1.6" />
						<circle cx="18" cy="12" r="1.6" />
					</svg>
				</span>
			)
		}
		return (
			<span mix={css(pickerMarkCss)} aria-hidden="true">
				<img
					src={`/images/icons/${icon}.svg`}
					alt=""
					width={28}
					height={28}
					mix={css(pickerIconImgCss)}
				/>
			</span>
		)
	}
}

function AgentAuthCallout(
	handle: Handle<{ agent: McpClientKind; surface: OnboardingAgentSurface }>,
) {
	return () => (
		<div
			mix={css(authNoteCss)}
			role="note"
			data-testid="onboarding-authenticate-callout"
		>
			<strong>Authenticate Kody before you continue</strong>
			<span>
				{renderAgentAuthHint(handle.props.agent, handle.props.surface)}
			</span>
			<span>
				Approve the <strong>kody.codes</strong> OAuth window. This is the step
				that connects your agent to your factory.
			</span>
		</div>
	)
}

function renderAgentAuthHint(
	kind: McpClientKind,
	surface: OnboardingAgentSurface,
) {
	switch (kind) {
		case 'cursor':
			return surface === 'mobile' ? (
				<>
					After installing the plugin, open Cursor on the web and complete{' '}
					<strong>Authenticate</strong> if it asks.
				</>
			) : (
				<>
					After installing the plugin, open the Cursor MCP list and click{' '}
					<strong>Authenticate</strong>.
				</>
			)
		case 'claude-code':
			return surface === 'mobile' ? (
				<>Complete OAuth in the Claude app under Settings → Connectors.</>
			) : (
				<>
					After install, enter <code>/mcp</code> → Kody →{' '}
					<strong>Authenticate</strong>.
				</>
			)
		case 'chatgpt':
			return (
				<>Complete OAuth when ChatGPT prompts you after creating the app.</>
			)
		case 'codex':
			return surface === 'mobile' ? (
				<>Complete OAuth when the ChatGPT app prompts you.</>
			) : (
				<>
					Run <code>{codexMcpLoginCommand}</code> if OAuth does not start
					automatically.
				</>
			)
		case 'claude-desktop':
			return <>Complete OAuth in Settings → Connectors.</>
		case 'grok':
			return (
				<>Complete OAuth when Grok prompts you after adding the connector.</>
			)
		case 'grok-cli':
			return surface === 'mobile' ? (
				<>
					Authenticate on a computer. In the TUI, <code>/mcps</code> then{' '}
					<strong>i</strong>. Or change selection and choose{' '}
					<strong>Grok Bot</strong>.
				</>
			) : (
				<>
					OAuth opens on first use. In the TUI, <code>/mcps</code> then{' '}
					<strong>i</strong> authenticates. <code>grok mcp doctor kody</code>{' '}
					checks the connection.
				</>
			)
		case 'grok-bot':
			return surface === 'mobile' ? (
				<>
					After adding the plugin, complete <strong>Authorize</strong> when Grok
					Bot prompts you on your phone or on a computer.
				</>
			) : (
				<>
					After adding the plugin, complete <strong>Authorize</strong> when Grok
					Bot prompts you.
				</>
			)
		case 'opencode':
			return surface === 'mobile' ? (
				<>Authenticate on a computer if prompted.</>
			) : (
				<>
					Run <code>{openCodeMcpAuthCommand}</code> if prompted.
				</>
			)
		case 'openclaw':
			return surface === 'mobile' ? (
				<>
					Save the server in the Control UI, then run{' '}
					<code>{openClawMcpLoginCommand}</code> on a computer. Approve the Kody
					OAuth window.
				</>
			) : (
				<>
					Run <code>{openClawMcpLoginCommand}</code> after the server is saved.
					Approve the Kody OAuth window.
				</>
			)
		case 'copilot':
			return surface === 'mobile' ? (
				<>Complete OAuth when the GitHub or Copilot app opens it.</>
			) : (
				<>Complete OAuth when VS Code or Copilot CLI opens it.</>
			)
		case 'copilot-app':
			return <>Complete OAuth when the Copilot app opens it.</>
		case 'devin':
			return <>Complete OAuth when Devin opens it.</>
		case 'gemini':
			return <>Complete OAuth when Gemini or Jules prompts you.</>
		case 'other':
			return <>Complete OAuth when the host opens it.</>
		default: {
			const exhaustive: never = kind
			return exhaustive
		}
	}
}

/**
 * Step 1: pick one agent, then show only that host's install path and
 * authenticate hint. Featured hosts are the first chooser; other named
 * hosts are under More; **Not listed** is the generic MCP URL path.
 */
export function OnboardingMcpClientTabs(
	handle: Handle<OnboardingMcpClientTabsProps>,
) {
	return () => {
		const { mcpServerUrl, highlights } = handle.props
		const selectedAgent = handle.props.selectedAgent ?? null
		const surface = handle.props.surface ?? 'desktop'
		const location = handle.props.agentLocation ?? {
			pathname: '/onboarding',
			search: '',
			hash: '',
		}

		if (!selectedAgent) {
			return (
				<div data-testid="onboarding-agent-picker" mix={css(installLayoutCss)}>
					<p mix={css(pickerLedeCss)} id="onboarding-agent-picker-label">
						Choose the agent you want to connect first. You can add others
						later.
					</p>
					<AgentPickerGrid
						surface="desktop"
						chooser={handle.props.chooser}
						location={location}
					/>
					<AgentPickerGrid
						surface="mobile"
						chooser={handle.props.chooser}
						location={location}
					/>
				</div>
			)
		}

		const changeHref = buildOnboardingAgentHref({
			...location,
			agent: null,
		})

		return (
			<div
				data-testid="onboarding-agent-instructions"
				data-agent={selectedAgent}
				data-surface={surface}
				mix={css(installLayoutCss)}
			>
				<div mix={css(selectedHeadCss)}>
					<p mix={css(selectedKickerCss)}>
						Connecting <strong>{pickerLabel(selectedAgent, surface)}</strong>
					</p>
					<a
						href={changeHref}
						data-testid="onboarding-agent-change"
						data-prevent-scroll-reset=""
						mix={css(changeSelectionCss)}
					>
						Change selection
					</a>
				</div>
				<div mix={css(selectedPanelCss)}>
					{renderPanelContent(selectedAgent, mcpServerUrl, highlights, surface)}
				</div>
				{selectedAgent === 'other' ? (
					<div mix={css(moreAgentsCss)}>
						<p mix={css(pickerLedeCss)} id="onboarding-more-agents-label">
							These hosts have their own steps:
						</p>
						<ul
							aria-labelledby="onboarding-more-agents-label"
							mix={css(moreAgentListCss)}
						>
							{onboardingMoreIdsFromChooser(
								handle.props.chooser ?? canonicalOnboardingAgentChooser(),
								surface,
							).map((id) => (
								<li key={id}>
									<a
										href={buildOnboardingAgentHref({
											...location,
											agent: id,
											surface,
										})}
										data-testid={`onboarding-agent-${id}`}
										data-prevent-scroll-reset=""
										mix={css(moreAgentChipCss)}
									>
										{pickerLabel(id, surface)}
									</a>
								</li>
							))}
						</ul>
					</div>
				) : null}
				<AgentAuthCallout agent={selectedAgent} surface={surface} />
			</div>
		)
	}
}

function AgentPickerGrid(
	handle: Handle<{
		surface: OnboardingAgentSurface
		chooser?: OnboardingAgentChooserPick | null
		location: OnboardingAgentLocation
	}>,
) {
	return () => {
		const { surface, location } = handle.props
		const ids = onboardingFeaturedIdsFromChooser(
			handle.props.chooser ?? canonicalOnboardingAgentChooser(),
			surface,
		)
		return (
			<ul
				aria-labelledby="onboarding-agent-picker-label"
				data-surface={surface}
				mix={css(
					surface === 'mobile' ? pickerGridMobileCss : pickerGridDesktopCss,
				)}
			>
				{[...ids, 'other' as const].map((id) => (
					<li key={id}>
						<a
							href={buildOnboardingAgentHref({
								...location,
								agent: id,
								surface,
							})}
							data-testid={`onboarding-agent-${id}`}
							data-prevent-scroll-reset=""
							mix={css(pickerCardCss)}
						>
							<AgentPickerMark agent={id} surface={surface} />
							<strong>{pickerLabel(id, surface)}</strong>
						</a>
					</li>
				))}
			</ul>
		)
	}
}

const installLayoutCss = {
	display: 'grid',
	gap: '1.15rem',
}

const pickerLedeCss = {
	margin: 0,
	color: colors.textMuted,
	maxWidth: '72ch',
}

const pickerGridCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gridTemplateColumns: 'repeat(auto-fill, minmax(min(10.5rem, 100%), 1fr))',
	gap: '0.75rem',
}

const pickerGridDesktopCss = {
	...pickerGridCss,
	[onboardingMobileAgentMq]: {
		display: 'none',
	},
}

const pickerGridMobileCss = {
	...pickerGridCss,
	display: 'none',
	[onboardingMobileAgentMq]: {
		display: 'grid',
	},
}

const pickerCardCss = {
	display: 'grid',
	justifyItems: 'center',
	gap: '0.55rem',
	width: '100%',
	minWidth: 0,
	padding: '1.05rem 0.85rem',
	backgroundColor: colors.background,
	border: `1.5px solid ${colors.border}`,
	borderRadius: radius.card,
	color: colors.text,
	cursor: 'pointer',
	textDecoration: 'none',
	boxSizing: 'border-box' as const,
	textAlign: 'center' as const,
	font: `650 0.98rem/1.25 ${typography.fontFamilyBody}`,
	transition: `border-color 160ms ${transitions.easeOut}, transform 160ms ${transitions.easeOut}`,
	[hoverMq]: {
		'&:hover': {
			borderColor: colors.primary,
			transform: 'translateY(-2px)',
		},
	},
	'&:active': { transform: 'translateY(0)' },
	'@media (prefers-reduced-motion: reduce)': {
		transition: `border-color 160ms ${transitions.easeOut}`,
		'&:hover': { transform: 'none' },
		'&:active': { transform: 'none' },
	},
}

const pickerMarkCss = getLogoWellCss({ size: '2.4rem', radius: '12px' })

const pickerIconImgCss = {
	display: 'block',
	width: '1.55rem',
	height: '1.55rem',
	objectFit: 'contain' as const,
}

const selectedHeadCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'center',
	justifyContent: 'space-between',
	gap: '0.6rem 1rem',
}

const selectedKickerCss = {
	margin: 0,
	color: colors.textMuted,
	'& strong': {
		color: colors.text,
	},
}

const changeSelectionCss = {
	...getGhostButtonCss(),
	textDecoration: 'none',
}

const selectedPanelCss = {
	display: 'grid',
	gap: '0.9rem',
	minWidth: 0,
	color: colors.text,
	'@media (prefers-reduced-motion: no-preference)': {
		transition: `opacity 240ms ${transitions.easeOut}, translate 240ms ${transitions.easeOut}`,
	},
	'@starting-style': {
		opacity: 0,
		translate: '0 6px',
	},
	'& > p': {
		margin: 0,
		color: colors.textMuted,
		maxWidth: '72ch',
	},
	'& > p a': {
		color: colors.primaryText,
	},
	'& code': {
		font: '500 0.88em ui-monospace, "SF Mono", Menlo, monospace',
		color: colors.text,
		backgroundColor: colors.background,
		border: `1px solid ${colors.border}`,
		borderRadius: '6px',
		padding: '0.1em 0.4em',
	},
	'& pre code': {
		font: 'inherit',
		color: 'inherit',
		backgroundColor: 'transparent',
		border: 'none',
		borderRadius: 0,
		padding: 0,
	},
}

const moreAgentsCss = {
	display: 'grid',
	gap: '0.6rem',
}

const moreAgentListCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: '0.5rem',
}

const moreAgentChipCss = {
	width: 'auto',
	padding: '0.5rem 0.9rem',
	backgroundColor: colors.background,
	border: `1.5px solid ${colors.border}`,
	borderRadius: radius.full,
	color: colors.text,
	cursor: 'pointer',
	textDecoration: 'none',
	font: `550 0.95rem/1 ${typography.fontFamilyBody}`,
	transition: `border-color 160ms ${transitions.easeOut}, color 160ms ${transitions.easeOut}`,
	[hoverMq]: {
		'&:hover': {
			borderColor: colors.primary,
			color: colors.primaryText,
		},
	},
}

const authNoteCss = {
	...getAccentCalloutCss({ accentColor: colors.primary }),
	gap: '0.55rem',
	padding: '1.2rem 1.35rem',
	borderLeftWidth: '6px',
	backgroundColor: `oklch(from ${colors.primary} l c h / 0.14)`,
	boxShadow: `0 10px 28px oklch(from ${colors.primary} l c h / 0.12)`,
	'& > strong': {
		font: `750 1.2rem/1.15 ${typography.fontFamilyDisplay}`,
		color: colors.primaryText,
	},
	'& > span': {
		color: colors.text,
		lineHeight: 1.5,
	},
	'& code': {
		font: '600 0.9em ui-monospace, "SF Mono", Menlo, monospace',
	},
}

const deepLinkCss = {
	display: 'grid',
	gap: '0.45rem',
	justifyItems: 'start',
}

const deepLinkButtonCss = getPillButtonCss()

const deepLinkNoteCss = {
	color: colors.textMuted,
	fontSize: '0.88rem',
}

const pluginAlternativeCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'center',
	gap: '0.35rem 0.5rem',
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.88rem',
	maxWidth: '72ch',
	'& code': {
		overflowWrap: 'anywhere' as const,
	},
}

/* Config snippets: labeled wells with their copy button in the header. */
const snippetCss = {
	border: `1.5px solid ${colors.border}`,
	borderRadius: radius.card,
	backgroundColor: colors.background,
	overflow: 'hidden' as const,
	minWidth: 0,
}

const snippetHeadCss = {
	display: 'flex',
	justifyContent: 'space-between',
	alignItems: 'center',
	gap: '0.6rem',
	padding: '0.5rem 0.6rem 0.5rem 1.1rem',
	borderBottom: `1px solid ${colors.border}`,
	'@media (max-width: 720px)': {
		flexWrap: 'wrap' as const,
	},
}

const snippetLabelCss = {
	font: `700 0.75rem/1 ${typography.fontFamilyDisplay}`,
	textTransform: 'uppercase' as const,
	letterSpacing: '0.09em',
	color: colors.textMuted,
}

/* Header copy buttons run one size down from the standalone pills. */
const snippetActionCss = {
	'& > button': {
		fontSize: '0.88rem',
		padding: '0.5rem 1rem',
	},
}

const snippetPreCss = {
	'& pre': {
		margin: 0,
		padding: '1rem 1.2rem',
		font: '500 0.92rem/1.6 ui-monospace, "SF Mono", Menlo, monospace',
		whiteSpace: 'pre-wrap' as const,
		wordBreak: 'break-word' as const,
		backgroundColor: 'transparent',
		overflow: 'visible' as const,
	},
	'& pre code': {
		font: 'inherit',
		color: 'inherit',
		backgroundColor: 'transparent',
		border: 'none',
		borderRadius: 0,
		padding: 0,
	},
}

const clientNoteCss = {
	margin: '0.3rem 0 0',
	padding: '0.15rem 0 0.15rem 1rem',
	borderLeft: `3px solid oklch(from ${colors.primary} l c h / 0.55)`,
	color: colors.textMuted,
	fontSize: '0.95rem',
	maxWidth: '62ch',
}
