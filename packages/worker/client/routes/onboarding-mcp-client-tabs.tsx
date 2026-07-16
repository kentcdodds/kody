import { type Handle, css } from 'remix/ui'
import { Tab, TabList, TabPanel, Tabs } from 'remix/ui/tabs'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import {
	buildClaudeCodeAddCommand,
	buildClaudeCodeMcpJson,
	buildCodexMcpToml,
	buildCursorMcpJson,
	buildOpenCodeMcpJson,
	buildVsCodeMcpJson,
	codingAgentPackageHint,
	mcpClientTabs,
	nonCodingAgentNote,
} from '#client/routes/onboarding-mcp-clients.ts'
import { colors, spacing, typography } from '#client/styles/tokens.ts'
import {
	descriptionCss,
	insetCardCss,
} from '#client/styles/style-primitives.ts'

type OnboardingMcpClientTabsProps = {
	mcpServerUrl: string
}

function ConfigSnippet(handle: Handle<{ value: string; idleLabel: string }>) {
	return () => (
		<div mix={css(snippetWrapCss)}>
			<pre mix={css(codeBlockCss)}>{handle.props.value}</pre>
			<CopyTextButton
				value={handle.props.value}
				idleLabel={handle.props.idleLabel}
				variant="secondary"
			/>
		</div>
	)
}

function ClientNote(handle: Handle<{ children: string }>) {
	return () => (
		<p mix={css(noteCss)} role="note">
			{handle.props.children}
		</p>
	)
}

export function OnboardingMcpClientTabs(
	handle: Handle<OnboardingMcpClientTabsProps>,
) {
	return () => {
		const mcpServerUrl = handle.props.mcpServerUrl
		const cursorJson = buildCursorMcpJson(mcpServerUrl)
		const claudeCodeJson = buildClaudeCodeMcpJson(mcpServerUrl)
		const claudeCodeCommand = buildClaudeCodeAddCommand(mcpServerUrl)
		const vsCodeJson = buildVsCodeMcpJson(mcpServerUrl)
		const openCodeJson = buildOpenCodeMcpJson(mcpServerUrl)
		const codexToml = buildCodexMcpToml(mcpServerUrl)

		return (
			<Tabs defaultActiveTab="cursor">
				<TabList aria-label="MCP client setup instructions">
					{mcpClientTabs.map((tab) => (
						<Tab name={tab.id}>{tab.label}</Tab>
					))}
				</TabList>

				<TabPanel name="cursor">
					<p mix={css(descriptionCss)}>
						In Cursor, open <strong>Customize</strong> and add a remote MCP
						server with this URL, or merge the JSON below into{' '}
						<code>~/.cursor/mcp.json</code> (global) or{' '}
						<code>.cursor/mcp.json</code> (project).
					</p>
					<pre mix={css(codeBlockCss)}>{mcpServerUrl}</pre>
					<div mix={css(buttonRowCss)}>
						<CopyTextButton
							value={mcpServerUrl}
							idleLabel="Copy MCP URL"
							variant="primary"
						/>
					</div>
					<p mix={css(descriptionCss)}>
						JSON config (merge under your existing <code>mcpServers</code> if
						you already have one):
					</p>
					<ConfigSnippet value={cursorJson} idleLabel="Copy JSON" />
					<ClientNote>{codingAgentPackageHint}</ClientNote>
				</TabPanel>

				<TabPanel name="codex-chatgpt">
					<p mix={css(descriptionCss)}>
						<strong>ChatGPT (web)</strong>: turn on Developer mode under
						Settings → Security and login, then create a developer-mode app /
						connector pointed at the MCP URL below. Complete OAuth when
						prompted.
					</p>
					<pre mix={css(codeBlockCss)}>{mcpServerUrl}</pre>
					<div mix={css(buttonRowCss)}>
						<CopyTextButton
							value={mcpServerUrl}
							idleLabel="Copy MCP URL"
							variant="primary"
						/>
					</div>
					<ClientNote>{nonCodingAgentNote}</ClientNote>
					<p mix={css(descriptionCss)}>
						<strong>Codex</strong> (ChatGPT desktop, Codex CLI, and the IDE
						extension) share <code>~/.codex/config.toml</code>. Add this
						streamable HTTP entry, then run <code>codex mcp login kody</code> if
						OAuth does not start automatically:
					</p>
					<ConfigSnippet value={codexToml} idleLabel="Copy TOML" />
				</TabPanel>

				<TabPanel name="claude-desktop">
					<p mix={css(descriptionCss)}>
						In Claude Desktop, open <strong>Settings → Connectors</strong> (or
						Customize → Connectors), add a custom connector, and paste this MCP
						URL. Claude Desktop handles remote OAuth through that UI — do not
						put the remote URL into <code>claude_desktop_config.json</code>.
					</p>
					<pre mix={css(codeBlockCss)}>{mcpServerUrl}</pre>
					<div mix={css(buttonRowCss)}>
						<CopyTextButton
							value={mcpServerUrl}
							idleLabel="Copy MCP URL"
							variant="primary"
						/>
					</div>
					<ClientNote>{nonCodingAgentNote}</ClientNote>
				</TabPanel>

				<TabPanel name="claude-code">
					<p mix={css(descriptionCss)}>
						Prefer the CLI (user scope, all projects):
					</p>
					<ConfigSnippet value={claudeCodeCommand} idleLabel="Copy command" />
					<p mix={css(descriptionCss)}>
						Or merge this into a project <code>.mcp.json</code> (or the
						user-scoped <code>mcpServers</code> block). Claude Code requires{' '}
						<code>type: &quot;http&quot;</code> for remote servers:
					</p>
					<ConfigSnippet value={claudeCodeJson} idleLabel="Copy JSON" />
					<ClientNote>{codingAgentPackageHint}</ClientNote>
				</TabPanel>

				<TabPanel name="opencode">
					<p mix={css(descriptionCss)}>
						Add this to your OpenCode config (<code>opencode.json</code> in the
						project, or your global OpenCode config). OpenCode uses{' '}
						<code>type: &quot;remote&quot;</code> and will start OAuth when
						needed:
					</p>
					<ConfigSnippet value={openCodeJson} idleLabel="Copy JSON" />
					<p mix={css(descriptionCss)}>
						You can also run <code>opencode mcp add</code> and paste the URL
						interactively, then <code>opencode mcp auth kody</code> if prompted.
					</p>
					<ClientNote>{codingAgentPackageHint}</ClientNote>
				</TabPanel>

				<TabPanel name="vscode">
					<p mix={css(descriptionCss)}>
						Create or edit <code>.vscode/mcp.json</code> in your workspace (or
						open user MCP config via the{' '}
						<strong>MCP: Open User Configuration</strong> command). VS Code uses
						the root key <code>servers</code>, not <code>mcpServers</code>:
					</p>
					<ConfigSnippet value={vsCodeJson} idleLabel="Copy JSON" />
					<p mix={css(descriptionCss)}>
						Use Agent mode in Copilot Chat so MCP tools are available, then
						complete OAuth when VS Code opens it.
					</p>
					<ClientNote>{codingAgentPackageHint}</ClientNote>
				</TabPanel>

				<TabPanel name="other">
					<p mix={css(descriptionCss)}>
						Any MCP-capable host that supports remote / streamable HTTP servers
						can connect to Kody. Add a remote MCP server pointed at this URL and
						complete the OAuth flow when the host opens it:
					</p>
					<pre mix={css(codeBlockCss)}>{mcpServerUrl}</pre>
					<div mix={css(buttonRowCss)}>
						<CopyTextButton
							value={mcpServerUrl}
							idleLabel="Copy MCP URL"
							variant="primary"
						/>
					</div>
					<p mix={css(descriptionCss)}>
						Config file shapes differ by host. If your client expects a JSON{' '}
						<code>mcpServers</code> map with a <code>url</code> field, start
						from the Cursor snippet; if it uses <code>servers</code> with{' '}
						<code>type: &quot;http&quot;</code>, use the VS Code snippet.
					</p>
				</TabPanel>
			</Tabs>
		)
	}
}

const codeBlockCss = {
	...insetCardCss,
	margin: 0,
	whiteSpace: 'pre-wrap' as const,
	wordBreak: 'break-word' as const,
	fontFamily: typography.fontFamily,
	fontSize: typography.fontSize.sm,
	lineHeight: 1.6,
}

const snippetWrapCss = {
	display: 'grid',
	gap: spacing.sm,
}

const buttonRowCss = {
	display: 'flex',
	gap: spacing.sm,
	flexWrap: 'wrap' as const,
}

const noteCss = {
	...descriptionCss,
	margin: 0,
	padding: spacing.md,
	borderRadius: 'var(--radius-md)',
	border: `1px solid ${colors.border}`,
	background: colors.primarySoftest,
}
