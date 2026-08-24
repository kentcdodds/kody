import { type Handle, type RemixNode, css } from 'remix/ui'
import { Tab, TabList, TabPanel, Tabs } from 'remix/ui/tabs'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import {
	buildClaudeCodeAddCommand,
	buildClaudeCodeMcpJson,
	buildCodexMcpAddCommand,
	buildCodexMcpToml,
	buildCopilotCliAddCommand,
	buildCopilotCliMcpJson,
	buildCursorInstallUrl,
	buildCursorMcpJson,
	buildGrokCliAddCommand,
	buildGrokCliMcpToml,
	buildKodyAppIconUrl,
	buildKodyCliInstallCommand,
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
	grokCliMcpGuideUrl,
	grokConnectorsUrl,
	grokCustomMcpGuideUrl,
	type McpClientKind,
	mcpClientTabs,
	nonCodingAgentNote,
	openCodeMcpAuthCommand,
} from '#client/routes/onboarding-mcp-clients.ts'
import {
	colors,
	radius,
	transitions,
	typography,
} from '#universal/styles/tokens.ts'
import {
	getPillButtonCss,
	hoverMq,
} from '#universal/styles/style-primitives.ts'
import { renderHighlightedCode } from '#client/syntax-highlight.tsx'

type OnboardingMcpClientTabsProps = {
	mcpServerUrl: string
}

type CopyCardProps = {
	label: string
	value: string
	copyLabel: string
	variant?: 'pill' | 'ghost'
	lang?: string | null
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
				{renderHighlightedCode(handle.props.value, handle.props.lang)}
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
	handle: Handle<{ href: string; label: 'Add to Cursor' | 'Add to VS Code' }>,
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

function AutomaticPath(handle: Handle<{ children?: RemixNode }>) {
	return () => (
		<div data-testid="onboarding-mcp-automatic" mix={css(installPathCss)}>
			<p mix={css(pathLabelCss)}>Automatic</p>
			{handle.props.children}
		</div>
	)
}

function ManualPath(handle: Handle<{ children?: RemixNode }>) {
	return () => (
		<details data-testid="onboarding-mcp-manual" mix={css(manualDetailsCss)}>
			<summary mix={css(manualSummaryCss)}>Manual</summary>
			<div mix={css(manualBodyCss)}>{handle.props.children}</div>
		</details>
	)
}

function renderPanelContent(kind: McpClientKind, mcpServerUrl: string) {
	switch (kind) {
		case 'cursor': {
			const cursorJson = buildCursorMcpJson(mcpServerUrl)
			const installUrl = buildCursorInstallUrl(mcpServerUrl)
			return (
				<>
					<p>
						Install with the deeplink, open <strong>Customize</strong> and add a
						remote MCP server with the URL, or merge the JSON into{' '}
						<code>~/.cursor/mcp.json</code> (global) or{' '}
						<code>.cursor/mcp.json</code> (project).
					</p>
					<InstallDeepLink href={installUrl} label="Add to Cursor" />
					<CopyCard
						label="MCP URL"
						value={mcpServerUrl}
						copyLabel="Copy MCP URL"
					/>
					<p>
						JSON config (merge under your existing <code>mcpServers</code> if
						you already have one):
					</p>
					<CopyCard
						label="mcp.json"
						value={cursorJson}
						copyLabel="Copy JSON"
						lang="json"
					/>
					<ClientNote>{codingAgentPackageHint}</ClientNote>
				</>
			)
		}
		case 'chatgpt': {
			const appIconUrl = buildKodyAppIconUrl(mcpServerUrl)
			return (
				<>
					<p>
						This tab is <strong>chatgpt.com</strong> (web). ChatGPT desktop is
						Codex — use that tab, or the Automatic CLI. On chatgpt.com, turn on{' '}
						<strong>Developer mode</strong> under Settings → Security and login.
						Developer mode is available on the web for{' '}
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
						<strong>Settings → Plugins → Browse plugins → Create app</strong>{' '}
						and paste the MCP URL as the server URL. Complete OAuth when
						prompted.
					</p>
					<CopyCard
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
						label="App icon (favicon)"
						value={appIconUrl}
						copyLabel="Copy icon URL"
					/>
					<ClientNote>{nonCodingAgentNote}</ClientNote>
				</>
			)
		}
		case 'codex': {
			const codexCommand = buildCodexMcpAddCommand(mcpServerUrl)
			const codexToml = buildCodexMcpToml(mcpServerUrl)
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
						label="codex CLI"
						value={codexCommand}
						copyLabel="Copy command"
						lang="sh"
					/>
					<CopyCard
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
						In Claude Desktop, open <strong>Settings → Connectors</strong> (or
						Customize → Connectors), add a custom connector, and paste this MCP
						URL. Claude Desktop handles remote OAuth through that UI.
					</p>
					<CopyCard
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
						In{' '}
						<a
							href={grokConnectorsUrl}
							target="_blank"
							rel="noreferrer noopener"
						>
							Grok.com → Connectors
						</a>
						, click <strong>New Connector</strong>, select{' '}
						<strong>Custom</strong>, and paste this MCP URL. Complete OAuth when
						Grok prompts you. For Grok Business and Enterprise, a team admin
						must first add this custom MCP server in the cloud console. Members
						can then connect it from the Grok connectors page. See xAI&apos;s{' '}
						<a
							href={grokCustomMcpGuideUrl}
							target="_blank"
							rel="noreferrer noopener"
						>
							custom MCP connector docs
						</a>{' '}
						for details.
					</p>
					<CopyCard
						label="MCP URL"
						value={mcpServerUrl}
						copyLabel="Copy MCP URL"
						variant="pill"
					/>
					<p>
						For the Grok CLI, use the <strong>Grok CLI</strong> tab.
					</p>
					<ClientNote>{nonCodingAgentNote}</ClientNote>
				</>
			)
		case 'grok-cli': {
			const grokCliCommand = buildGrokCliAddCommand(mcpServerUrl)
			const grokCliToml = buildGrokCliMcpToml(mcpServerUrl)
			return (
				<>
					<p>
						Add a remote HTTP server (writes <code>~/.grok/config.toml</code>).
						OAuth opens a browser on first use; in the TUI, <code>/mcps</code>{' '}
						then <strong>i</strong> authenticates:
					</p>
					<CopyCard
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
						project scope. For grok.com, use the <strong>Grok.com</strong> tab.
					</p>
					<ClientNote>{codingAgentPackageHint}</ClientNote>
				</>
			)
		}
		case 'claude-code': {
			const claudeCodeCommand = buildClaudeCodeAddCommand(mcpServerUrl)
			const claudeCodeJson = buildClaudeCodeMcpJson(mcpServerUrl)
			return (
				<>
					<p>
						Run this (user scope, all projects), or merge the JSON into a
						project <code>.mcp.json</code> (or the user-scoped{' '}
						<code>mcpServers</code> block). Claude Code requires{' '}
						<code>type: &quot;http&quot;</code> for remote servers:
					</p>
					<CopyCard
						label="claude CLI"
						value={claudeCodeCommand}
						copyLabel="Copy command"
						lang="sh"
					/>
					<CopyCard
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
					<p>
						Run this to add Kody as a remote MCP server, then{' '}
						<code>{openCodeMcpAuthCommand}</code> if prompted. Or add the remote
						entry to your OpenCode config (<code>opencode.json</code> in the
						project, or your global OpenCode config). OpenCode uses{' '}
						<code>type: &quot;remote&quot;</code>:
					</p>
					<CopyCard
						label="opencode CLI"
						value={openCodeCommand}
						copyLabel="Copy command"
						lang="sh"
					/>
					<CopyCard
						label="opencode.json"
						value={openCodeJson}
						copyLabel="Copy JSON"
						lang="json"
					/>
					<ClientNote>{codingAgentPackageHint}</ClientNote>
				</>
			)
		}
		case 'copilot': {
			const vsCodeJson = buildVsCodeMcpJson(mcpServerUrl)
			const installUrl = buildVsCodeInstallUrl(mcpServerUrl)
			const copilotCliCommand = buildCopilotCliAddCommand(mcpServerUrl)
			const copilotCliJson = buildCopilotCliMcpJson(mcpServerUrl)
			return (
				<>
					<p>
						Run this to add a remote HTTP server for Copilot CLI (writes{' '}
						<code>~/.copilot/mcp-config.json</code>). Copilot CLI does not read{' '}
						<code>.vscode/mcp.json</code>:
					</p>
					<CopyCard
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
						for details. For the desktop GitHub Copilot app, use the{' '}
						<strong>Copilot App</strong> tab.
					</p>
					<ClientNote>{codingAgentPackageHint}</ClientNote>
				</>
			)
		}
		case 'copilot-app': {
			const copilotCliJson = buildCopilotCliMcpJson(mcpServerUrl)
			return (
				<>
					<p>
						In the GitHub Copilot app, open settings and go to{' '}
						<strong>MCP Servers</strong>. Add a custom remote HTTP server with
						this MCP URL, then complete OAuth when the app opens it:
					</p>
					<CopyCard
						label="MCP URL"
						value={mcpServerUrl}
						copyLabel="Copy MCP URL"
					/>
					<p>
						Servers you already configured for Copilot CLI (or in a repository)
						are also available in the app. You can merge this into{' '}
						<code>~/.copilot/mcp-config.json</code> instead:
					</p>
					<CopyCard
						label="~/.copilot/mcp-config.json"
						value={copilotCliJson}
						copyLabel="Copy JSON"
						lang="json"
					/>
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
						label="MCP URL"
						value={mcpServerUrl}
						copyLabel="Copy MCP URL"
					/>
					<p>
						Config file shapes differ by host. If your client expects a JSON{' '}
						<code>mcpServers</code> map with a <code>url</code> field, start
						from the Cursor or Copilot CLI snippet; if it uses{' '}
						<code>servers</code> with <code>type: &quot;http&quot;</code>, use
						the Copilot (VS Code) snippet.
					</p>
				</>
			)
		default: {
			const exhaustive: never = kind
			return exhaustive
		}
	}
}

/**
 * Step 1 install: one Automatic `@kodycodes/cli` command for every client,
 * then a collapsed Manual section with host chips and deeplink / vendor CLI
 * / JSON-TOML fallbacks. Roving tabindex and arrow keys come from
 * `remix/ui/tabs`.
 */
export function OnboardingMcpClientTabs(
	handle: Handle<OnboardingMcpClientTabsProps>,
) {
	return () => {
		const installCommand = buildKodyCliInstallCommand(handle.props.mcpServerUrl)
		return (
			<div mix={css(installLayoutCss)}>
				<AutomaticPath>
					<p>
						Run this to add Kody to the local agents the CLI finds (Cursor,
						Claude Desktop, VS Code, Claude Code, Codex / ChatGPT desktop, and
						others). Then Authenticate in that client. Web hosts such as
						ChatGPT.com, Claude.ai, and Grok stay under Manual.
					</p>
					<CopyCard
						label="Install command"
						value={installCommand}
						copyLabel="Copy command"
						variant="pill"
						lang="sh"
					/>
				</AutomaticPath>
				<ManualPath>
					<p>
						Use a host-specific deeplink, vendor CLI, or config snippet instead.
					</p>
					<Tabs defaultActiveTab="cursor" mix={css(tabsRootCss)}>
						<div mix={css(tabPickerCss)}>
							<p mix={css(tabKickerCss)} id="onboarding-client-label">
								Choose your client
							</p>
							<TabList
								aria-labelledby="onboarding-client-label"
								mix={css(tabListCss)}
							>
								{mcpClientTabs.map((tab) => (
									<Tab key={tab.id} name={tab.id} mix={css(tabPillCss)}>
										{tab.label}
									</Tab>
								))}
							</TabList>
						</div>

						{mcpClientTabs.map((tab) => (
							<TabPanel key={tab.id} name={tab.id} mix={css(tabPanelCss)}>
								{renderPanelContent(tab.id, handle.props.mcpServerUrl)}
							</TabPanel>
						))}
					</Tabs>
				</ManualPath>
			</div>
		)
	}
}

const installLayoutCss = {
	display: 'grid',
	gap: '1.15rem',
}

const tabsRootCss = {
	display: 'grid',
	gap: '1.15rem',
}

const tabPickerCss = {
	display: 'grid',
	gap: '0.6rem',
}

/* Same voice as the panel kickers (duplicated literal: importing it from
   `onboarding.tsx` would create a module cycle). */
const tabKickerCss = {
	margin: 0,
	font: `700 0.78rem/1 ${typography.fontFamilyDisplay}`,
	textTransform: 'uppercase' as const,
	letterSpacing: '0.09em',
	color: colors.primaryText,
}

const tabListCss = {
	display: 'flex',
	gap: '0.5rem',
	flexWrap: 'wrap' as const,
	width: '100%',
	padding: 0,
	background: 'transparent',
	boxShadow: 'none',
	overflow: 'visible',
}

const tabPillCss = {
	width: 'auto',
	height: 'auto',
	minHeight: 0,
	font: `550 0.95rem/1 ${typography.fontFamilyBody}`,
	color: colors.textMuted,
	backgroundColor: colors.background,
	border: `1.5px solid ${colors.border}`,
	borderRadius: radius.full,
	padding: '0.55rem 1rem',
	cursor: 'pointer',
	transition: `border-color 160ms ${transitions.easeOut}, color 160ms ${transitions.easeOut}, background-color 160ms ${transitions.easeOut}, scale 160ms ${transitions.easeOut}`,
	[hoverMq]: {
		'&:hover': {
			borderColor: colors.primary,
			color: colors.text,
		},
	},
	'&[data-state="active"]': {
		borderColor: colors.primary,
		backgroundColor: `oklch(from ${colors.primary} l c h / 0.12)`,
		color: colors.primaryText,
		fontWeight: 680,
	},
	'&:active': { scale: '0.97' },
	'@media (prefers-reduced-motion: reduce)': {
		'&:active': { scale: 'none' },
	},
}

/* Switching hosts slides the fresh instructions in — enhance-only by
   construction: @starting-style re-arms when the panel's `hidden` display
   toggles, which only happens through the JS-driven tabs. */
const tabPanelCss = {
	display: 'grid',
	gap: '0.9rem',
	minWidth: 0,
	color: colors.text,
	'&[hidden]': {
		display: 'none',
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
	// Snippet wells render Shiki as `<pre><code>`. Without this reset the
	// inline-code chip above paints a gray pill around every wrapped line.
	'& pre code': {
		font: 'inherit',
		color: 'inherit',
		backgroundColor: 'transparent',
		border: 'none',
		borderRadius: 0,
		padding: 0,
	},
	// Enters via @starting-style so a fast host-switch retargets the
	// in-flight transition instead of restarting keyframes from zero.
	'@media (prefers-reduced-motion: no-preference)': {
		transition: `opacity 240ms ${transitions.easeOut}, translate 240ms ${transitions.easeOut}`,
	},
	'@starting-style': {
		opacity: 0,
		translate: '0 6px',
	},
}

const installPathCss = {
	display: 'grid',
	gap: '0.75rem',
	'& > p': {
		margin: 0,
		color: colors.textMuted,
		maxWidth: '72ch',
	},
}

const pathLabelCss = {
	margin: 0,
	font: `700 1.05rem/1.3 ${typography.fontFamilyDisplay}`,
	color: colors.text,
}

const manualDetailsCss = {
	display: 'grid',
	gap: '0.4rem',
	'&[open] > summary': {
		marginBottom: '0.15rem',
	},
}

const manualSummaryCss = {
	cursor: 'pointer',
	width: 'fit-content',
	padding: '0.3rem 0',
	font: `700 1.05rem/1.3 ${typography.fontFamilyDisplay}`,
	color: colors.text,
	transition: `color ${transitions.fast}`,
	[hoverMq]: {
		'&:hover': {
			color: colors.primaryText,
		},
	},
}

const manualBodyCss = {
	display: 'grid',
	gap: '0.9rem',
	marginTop: '0.6rem',
	'& > p': {
		margin: 0,
		color: colors.textMuted,
		maxWidth: '72ch',
	},
	'& > p a': {
		color: colors.primaryText,
	},
	'@media (prefers-reduced-motion: no-preference)': {
		transition: `opacity 240ms ${transitions.easeOut}, translate 240ms ${transitions.easeOut}`,
	},
	'@starting-style': {
		opacity: 0,
		translate: '0 6px',
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
