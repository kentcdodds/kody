import { type Handle, css } from 'remix/ui'
import { Tab, TabList, TabPanel, Tabs } from 'remix/ui/tabs'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import {
	buildClaudeCodeAddCommand,
	buildClaudeCodeMcpJson,
	buildCodexMcpToml,
	buildCopilotCliAddCommand,
	buildCopilotCliMcpJson,
	buildCursorInstallUrl,
	buildCursorMcpJson,
	buildKodyAppIconUrl,
	buildOpenCodeMcpJson,
	buildVsCodeInstallUrl,
	buildVsCodeMcpJson,
	chatGptDeveloperModeGuideUrl,
	codingAgentPackageHint,
	copilotAppCustomizeGuideUrl,
	copilotCliMcpGuideUrl,
	grokConnectorsUrl,
	grokCustomMcpGuideUrl,
	type McpClientKind,
	mcpClientTabs,
	nonCodingAgentNote,
} from '#client/routes/onboarding-mcp-clients.ts'
import {
	colors,
	radius,
	transitions,
	typography,
} from '#client/styles/tokens.ts'
import { getPillButtonCss, hoverMq } from '#client/styles/style-primitives.ts'
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

function renderPanelContent(kind: McpClientKind, mcpServerUrl: string) {
	switch (kind) {
		case 'cursor': {
			const cursorJson = buildCursorMcpJson(mcpServerUrl)
			const installUrl = buildCursorInstallUrl(mcpServerUrl)
			return (
				<>
					<p>
						Install Kody directly, or open <strong>Customize</strong> and add a
						remote MCP server with the URL below. You can also merge the JSON
						into <code>~/.cursor/mcp.json</code> (global) or{' '}
						<code>.cursor/mcp.json</code> (project).
					</p>
					<InstallDeepLink href={installUrl} label="Add to Cursor" />
					<CopyCard
						label="MCP URL"
						value={mcpServerUrl}
						copyLabel="Copy MCP URL"
						variant="pill"
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
						In ChatGPT, turn on <strong>Developer mode</strong> under Settings →
						Security and login. Developer mode is available on the web for{' '}
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
						<strong>Settings → Plugins → Browse plugins → Create app</strong>.
						Paste the MCP URL below as the server URL. For the app icon,
						download Kody&apos;s favicon from the link below. Owners can edit a
						developer-mode app&apos;s name and logo later from its{' '}
						<strong>Manage</strong> menu in Apps settings. Complete OAuth when
						prompted.
					</p>
					<CopyCard
						label="MCP URL"
						value={mcpServerUrl}
						copyLabel="Copy MCP URL"
						variant="pill"
					/>
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
			const codexToml = buildCodexMcpToml(mcpServerUrl)
			return (
				<>
					<p>
						Codex (ChatGPT desktop, Codex CLI, and the IDE extension) shares{' '}
						<code>~/.codex/config.toml</code>. Add this streamable HTTP entry,
						then run <code>codex mcp login kody</code> if OAuth does not start
						automatically:
					</p>
					<CopyCard
						label="config.toml"
						value={codexToml}
						copyLabel="Copy TOML"
						variant="pill"
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
						URL. Claude Desktop handles remote OAuth through that UI — do not
						put the remote URL into <code>claude_desktop_config.json</code>.
					</p>
					<CopyCard
						label="MCP URL"
						value={mcpServerUrl}
						copyLabel="Copy MCP URL"
						variant="pill"
					/>
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
					<ClientNote>{nonCodingAgentNote}</ClientNote>
				</>
			)
		case 'claude-code': {
			const claudeCodeCommand = buildClaudeCodeAddCommand(mcpServerUrl)
			const claudeCodeJson = buildClaudeCodeMcpJson(mcpServerUrl)
			return (
				<>
					<p>Prefer the CLI (user scope, all projects):</p>
					<CopyCard
						label="claude CLI"
						value={claudeCodeCommand}
						copyLabel="Copy command"
						variant="pill"
						lang="sh"
					/>
					<p>
						Or merge this into a project <code>.mcp.json</code> (or the
						user-scoped <code>mcpServers</code> block). Claude Code requires{' '}
						<code>type: &quot;http&quot;</code> for remote servers:
					</p>
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
			const openCodeJson = buildOpenCodeMcpJson(mcpServerUrl)
			return (
				<>
					<p>
						Add this to your OpenCode config (<code>opencode.json</code> in the
						project, or your global OpenCode config). OpenCode uses{' '}
						<code>type: &quot;remote&quot;</code> and will start OAuth when
						needed:
					</p>
					<CopyCard
						label="opencode.json"
						value={openCodeJson}
						copyLabel="Copy JSON"
						variant="pill"
						lang="json"
					/>
					<p>
						You can also run <code>opencode mcp add</code> and paste the URL
						interactively, then <code>opencode mcp auth kody</code> if prompted.
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
			return (
				<>
					<p>
						<strong>In VS Code (Copilot Chat):</strong> install Kody directly,
						create or edit <code>.vscode/mcp.json</code> in your workspace, or
						open user MCP config via the{' '}
						<strong>MCP: Open User Configuration</strong> command. VS Code uses
						the root key <code>servers</code>, not <code>mcpServers</code>:
					</p>
					<InstallDeepLink href={installUrl} label="Add to VS Code" />
					<CopyCard
						label=".vscode/mcp.json"
						value={vsCodeJson}
						copyLabel="Copy JSON"
						variant="pill"
						lang="json"
					/>
					<p>
						Use Agent mode in Copilot Chat so MCP tools are available, then
						complete OAuth when VS Code opens it.
					</p>
					<p>
						<strong>In Copilot CLI:</strong> add a remote HTTP server (writes{' '}
						<code>~/.copilot/mcp-config.json</code>). Copilot CLI does not read{' '}
						<code>.vscode/mcp.json</code>:
					</p>
					<CopyCard
						label="copilot CLI"
						value={copilotCliCommand}
						copyLabel="Copy command"
						variant="pill"
						lang="sh"
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
						variant="pill"
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
						variant="pill"
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
 * Client picker (step 2): host chips in the same grammar as the landing host
 * cloud, one panel of setup instructions per host. Roving tabindex and arrow
 * keys come from `remix/ui/tabs`.
 */
export function OnboardingMcpClientTabs(
	handle: Handle<OnboardingMcpClientTabsProps>,
) {
	return () => (
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
	)
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
