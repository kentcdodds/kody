import { type Handle, css } from 'remix/ui'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { on } from '#client/event-mixin.ts'
import {
	buildClaudeCodeAddCommand,
	buildClaudeCodeMcpJson,
	buildCodexMcpToml,
	buildCursorMcpJson,
	buildKodyAppIconUrl,
	buildOpenCodeMcpJson,
	buildVsCodeMcpJson,
	chatGptDeveloperModeGuideUrl,
	codingAgentPackageHint,
	type McpClientKind,
	mcpClientTabs,
	nonCodingAgentNote,
} from '#client/routes/onboarding-mcp-clients.ts'
import {
	colors,
	mq,
	radius,
	spacing,
	typography,
} from '#client/styles/tokens.ts'
import {
	descriptionCss,
	getSecondaryButtonCss,
	pageEyebrowCss,
} from '#client/styles/style-primitives.ts'

type OnboardingMcpClientTabsProps = {
	mcpServerUrl: string
}

function tabButtonId(id: McpClientKind) {
	return `onboarding-mcp-client-tab-${id}`
}

function tabPanelId(id: McpClientKind) {
	return `onboarding-mcp-client-panel-${id}`
}

type CopyCardProps = {
	label: string
	value: string
	copyLabel: string
	variant?: 'primary' | 'secondary'
}

/**
 * Framed code block with a header row showing the file/target label on the
 * left and a matching copy button on the right. On narrow viewports the
 * header stacks and the copy button goes full width.
 */
function CopyCard(handle: Handle<CopyCardProps>) {
	return () => (
		<div mix={css(copyCardCss)}>
			<div mix={css(copyCardHeaderCss)}>
				<span mix={css(copyCardLabelCss)}>{handle.props.label}</span>
				<div mix={css(copyCardActionCss)}>
					<CopyTextButton
						value={handle.props.value}
						idleLabel={handle.props.copyLabel}
						variant={handle.props.variant ?? 'secondary'}
					/>
				</div>
			</div>
			<pre mix={css(codeBlockCss)}>{handle.props.value}</pre>
		</div>
	)
}

type ClientNoteProps = {
	children: string
}

function ClientNote(handle: Handle<ClientNoteProps>) {
	return () => (
		<p mix={css(noteCss)} role="note">
			{handle.props.children}
		</p>
	)
}

function renderPanelContent(kind: McpClientKind, mcpServerUrl: string) {
	switch (kind) {
		case 'cursor': {
			const cursorJson = buildCursorMcpJson(mcpServerUrl)
			return (
				<>
					<p mix={css(descriptionCss)}>
						In Cursor, open <strong>Customize</strong> and add a remote MCP
						server with this URL, or merge the JSON below into{' '}
						<code>~/.cursor/mcp.json</code> (global) or{' '}
						<code>.cursor/mcp.json</code> (project).
					</p>
					<CopyCard
						label="MCP URL"
						value={mcpServerUrl}
						copyLabel="Copy MCP URL"
						variant="primary"
					/>
					<p mix={css(descriptionCss)}>
						JSON config (merge under your existing <code>mcpServers</code> if
						you already have one):
					</p>
					<CopyCard label="mcp.json" value={cursorJson} copyLabel="Copy JSON" />
					<ClientNote>{codingAgentPackageHint}</ClientNote>
				</>
			)
		}
		case 'chatgpt': {
			const appIconUrl = buildKodyAppIconUrl(mcpServerUrl)
			return (
				<>
					<p mix={css(descriptionCss)}>
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
						variant="primary"
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
					<p mix={css(descriptionCss)}>
						Codex (ChatGPT desktop, Codex CLI, and the IDE extension) shares{' '}
						<code>~/.codex/config.toml</code>. Add this streamable HTTP entry,
						then run <code>codex mcp login kody</code> if OAuth does not start
						automatically:
					</p>
					<CopyCard
						label="config.toml"
						value={codexToml}
						copyLabel="Copy TOML"
					/>
					<ClientNote>{codingAgentPackageHint}</ClientNote>
				</>
			)
		}
		case 'claude-desktop':
			return (
				<>
					<p mix={css(descriptionCss)}>
						In Claude Desktop, open <strong>Settings → Connectors</strong> (or
						Customize → Connectors), add a custom connector, and paste this MCP
						URL. Claude Desktop handles remote OAuth through that UI — do not
						put the remote URL into <code>claude_desktop_config.json</code>.
					</p>
					<CopyCard
						label="MCP URL"
						value={mcpServerUrl}
						copyLabel="Copy MCP URL"
						variant="primary"
					/>
					<ClientNote>{nonCodingAgentNote}</ClientNote>
				</>
			)
		case 'claude-code': {
			const claudeCodeCommand = buildClaudeCodeAddCommand(mcpServerUrl)
			const claudeCodeJson = buildClaudeCodeMcpJson(mcpServerUrl)
			return (
				<>
					<p mix={css(descriptionCss)}>
						Prefer the CLI (user scope, all projects):
					</p>
					<CopyCard
						label="claude CLI"
						value={claudeCodeCommand}
						copyLabel="Copy command"
					/>
					<p mix={css(descriptionCss)}>
						Or merge this into a project <code>.mcp.json</code> (or the
						user-scoped <code>mcpServers</code> block). Claude Code requires{' '}
						<code>type: &quot;http&quot;</code> for remote servers:
					</p>
					<CopyCard
						label=".mcp.json"
						value={claudeCodeJson}
						copyLabel="Copy JSON"
					/>
					<ClientNote>{codingAgentPackageHint}</ClientNote>
				</>
			)
		}
		case 'opencode': {
			const openCodeJson = buildOpenCodeMcpJson(mcpServerUrl)
			return (
				<>
					<p mix={css(descriptionCss)}>
						Add this to your OpenCode config (<code>opencode.json</code> in the
						project, or your global OpenCode config). OpenCode uses{' '}
						<code>type: &quot;remote&quot;</code> and will start OAuth when
						needed:
					</p>
					<CopyCard
						label="opencode.json"
						value={openCodeJson}
						copyLabel="Copy JSON"
					/>
					<p mix={css(descriptionCss)}>
						You can also run <code>opencode mcp add</code> and paste the URL
						interactively, then <code>opencode mcp auth kody</code> if prompted.
					</p>
					<ClientNote>{codingAgentPackageHint}</ClientNote>
				</>
			)
		}
		case 'vscode': {
			const vsCodeJson = buildVsCodeMcpJson(mcpServerUrl)
			return (
				<>
					<p mix={css(descriptionCss)}>
						Create or edit <code>.vscode/mcp.json</code> in your workspace (or
						open user MCP config via the{' '}
						<strong>MCP: Open User Configuration</strong> command). VS Code uses
						the root key <code>servers</code>, not <code>mcpServers</code>:
					</p>
					<CopyCard
						label=".vscode/mcp.json"
						value={vsCodeJson}
						copyLabel="Copy JSON"
					/>
					<p mix={css(descriptionCss)}>
						Use Agent mode in Copilot Chat so MCP tools are available, then
						complete OAuth when VS Code opens it.
					</p>
					<ClientNote>{codingAgentPackageHint}</ClientNote>
				</>
			)
		}
		case 'other':
			return (
				<>
					<p mix={css(descriptionCss)}>
						Any MCP-capable host that supports remote / streamable HTTP servers
						can connect to Kody. Add a remote MCP server pointed at this URL and
						complete the OAuth flow when the host opens it:
					</p>
					<CopyCard
						label="MCP URL"
						value={mcpServerUrl}
						copyLabel="Copy MCP URL"
						variant="primary"
					/>
					<p mix={css(descriptionCss)}>
						Config file shapes differ by host. If your client expects a JSON{' '}
						<code>mcpServers</code> map with a <code>url</code> field, start
						from the Cursor snippet; if it uses <code>servers</code> with{' '}
						<code>type: &quot;http&quot;</code>, use the VS Code snippet.
					</p>
				</>
			)
		default: {
			const exhaustive: never = kind
			return exhaustive
		}
	}
}

export function OnboardingMcpClientTabs(
	handle: Handle<OnboardingMcpClientTabsProps>,
) {
	let selectedTab: McpClientKind = 'cursor'
	const secondaryButtonCss = getSecondaryButtonCss()

	function selectTab(id: McpClientKind) {
		if (selectedTab === id) return
		selectedTab = id
		handle.update()
	}

	return () => {
		const mcpServerUrl = handle.props.mcpServerUrl
		const activeTab = selectedTab

		return (
			<div mix={css(tabsRootCss)}>
				<div mix={css(tabPickerCss)}>
					<p mix={css(pageEyebrowCss)}>Choose your client</p>
					<div
						role="tablist"
						aria-label="MCP client setup instructions"
						mix={css(tabListCss)}
					>
						{mcpClientTabs.map((tab) => {
							const isActive = tab.id === activeTab
							return (
								<button
									key={tab.id}
									type="button"
									role="tab"
									id={tabButtonId(tab.id)}
									aria-selected={isActive}
									aria-controls={tabPanelId(tab.id)}
									tabIndex={isActive ? 0 : -1}
									mix={[
										on('click', () => selectTab(tab.id)),
										css({
											...secondaryButtonCss,
											...tabPillCss,
											...(isActive
												? {
														borderColor: colors.primary,
														backgroundColor: colors.primarySoftest,
														color: colors.primaryText,
														fontWeight: typography.fontWeight.medium,
													}
												: {}),
										}),
									]}
								>
									{tab.label}
								</button>
							)
						})}
					</div>
				</div>

				<div
					role="tabpanel"
					id={tabPanelId(activeTab)}
					aria-labelledby={tabButtonId(activeTab)}
					mix={css(tabPanelCss)}
				>
					{renderPanelContent(activeTab, mcpServerUrl)}
				</div>
			</div>
		)
	}
}

const tabsRootCss = {
	display: 'grid',
	gap: spacing.lg,
}

const tabPickerCss = {
	display: 'grid',
	gap: spacing.sm,
}

const tabListCss = {
	display: 'flex',
	gap: spacing.sm,
	flexWrap: 'wrap' as const,
}

const tabPillCss = {
	[mq.mobile]: {
		padding: `${spacing.xs} ${spacing.sm}`,
		fontSize: typography.fontSize.sm,
	},
}

const tabPanelCss = {
	display: 'grid',
	gap: spacing.md,
	minWidth: 0,
}

const copyCardCss = {
	display: 'grid',
	borderRadius: radius.md,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.background,
	overflow: 'hidden' as const,
	minWidth: 0,
}

const copyCardHeaderCss = {
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'space-between',
	gap: spacing.sm,
	padding: `${spacing.sm} ${spacing.md}`,
	borderBottom: `1px solid ${colors.border}`,
	backgroundColor: colors.surface,
	flexWrap: 'wrap' as const,
	[mq.mobile]: {
		flexDirection: 'column' as const,
		alignItems: 'stretch',
	},
}

const copyCardActionCss = {
	[mq.mobile]: {
		display: 'grid',
		width: '100%',
		'& > button': {
			width: '100%',
		},
	},
}

const copyCardLabelCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.xs,
	fontWeight: typography.fontWeight.semibold,
	textTransform: 'uppercase' as const,
	letterSpacing: '0.08em',
}

const codeBlockCss = {
	margin: 0,
	padding: spacing.md,
	whiteSpace: 'pre-wrap' as const,
	wordBreak: 'break-word' as const,
	fontFamily:
		'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
	fontSize: typography.fontSize.sm,
	lineHeight: 1.6,
	color: colors.text,
}

const noteCss = {
	...descriptionCss,
	margin: 0,
	padding: spacing.md,
	borderRadius: radius.md,
	border: `1px solid ${colors.border}`,
	background: colors.primarySoftest,
}
