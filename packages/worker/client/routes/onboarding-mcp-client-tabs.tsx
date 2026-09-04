import { type Handle, css } from 'remix/ui'
import { prefetchRouteHrefs } from '#client/client-router.tsx'
import {
	type McpClientKind,
	type OnboardingAgentChooserPick,
	type OnboardingAgentSurface,
	type OnboardingAgentViewport,
	canonicalOnboardingAgentChooser,
	codexMcpLoginCommand,
	onboardingAgentHelp,
	onboardingAgentIconName,
	onboardingAgentLabel,
	onboardingAgentViewport,
	onboardingNotListedAgentIds,
	onboardingPickerAgentIds,
	onboardingViewportCss,
	openClawMcpLoginCommand,
	openCodeMcpAuthCommand,
} from '#client/routes/onboarding-mcp-clients.ts'
import { onboardingAgentHref } from '#universal/onboarding-process.ts'
import {
	colors,
	radius,
	transitions,
	typography,
} from '#universal/styles/tokens.ts'
import {
	getAccentCalloutCss,
	hoverMq,
} from '#universal/styles/style-primitives.ts'
import { type HighlightedCode } from '#universal/highlighted-code.ts'
import { ChatGptDeveloperModeWarning } from './onboarding-mcp-client-cards.tsx'
import {
	renderPanelContent,
	renderPanelWarning,
} from './onboarding-mcp-client-panels.tsx'
import { onboardingAgentPickerPrefetchHrefs } from './onboarding-picker-prefetch.ts'

type OnboardingMcpClientTabsProps = {
	mcpServerUrl: string
	highlights?: Record<string, HighlightedCode>
	selectedAgent?: McpClientKind | null
	chooser?: OnboardingAgentChooserPick | null
	search?: string
}

function AgentMarkIcon(handle: Handle<{ icon: string | null }>) {
	return () => {
		if (!handle.props.icon) {
			return (
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
			)
		}
		return (
			<img
				src={`/images/icons/${handle.props.icon}.svg`}
				alt=""
				width={28}
				height={28}
				mix={css(pickerIconImgCss)}
			/>
		)
	}
}

export function AgentPickerMark(
	handle: Handle<{
		agent: McpClientKind
		testId?: string
	}>,
) {
	return () => {
		const desktopIcon = onboardingAgentIconName(handle.props.agent, 'desktop')
		const mobileIcon = onboardingAgentIconName(handle.props.agent, 'mobile')
		return (
			<span
				mix={css(pickerMarkCss)}
				aria-hidden="true"
				data-testid={handle.props.testId}
			>
				{desktopIcon === mobileIcon ? (
					<AgentMarkIcon icon={desktopIcon} />
				) : (
					<>
						<span mix={css(onboardingViewportCss('desktop-only', 'grid'))}>
							<AgentMarkIcon icon={desktopIcon} />
						</span>
						<span mix={css(onboardingViewportCss('mobile-only', 'grid'))}>
							<AgentMarkIcon icon={mobileIcon} />
						</span>
					</>
				)}
			</span>
		)
	}
}

function AgentSurfaceLabel(handle: Handle<{ agent: McpClientKind }>) {
	return () => {
		const desktop = onboardingAgentLabel(handle.props.agent, 'desktop')
		const mobile = onboardingAgentLabel(handle.props.agent, 'mobile')
		if (desktop === mobile) return desktop
		return (
			<>
				<span mix={css(onboardingViewportCss('desktop-only', 'inline'))}>
					{desktop}
				</span>
				<span mix={css(onboardingViewportCss('mobile-only', 'inline'))}>
					{mobile}
				</span>
			</>
		)
	}
}

function AgentHelpLink(handle: Handle<{ agent: McpClientKind }>) {
	return () => {
		const help = onboardingAgentHelp(handle.props.agent)
		if (handle.props.agent === 'chatgpt') {
			return (
				<ChatGptDeveloperModeWarning href={help.href} linkLabel={help.label} />
			)
		}
		return (
			<p mix={css(agentHelpCss)}>
				<a
					href={help.href}
					target="_blank"
					rel="noreferrer noopener"
					data-testid="onboarding-agent-help"
				>
					{help.label}
				</a>
			</p>
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
	let warmedKey = ''
	return () => {
		const { mcpServerUrl, highlights } = handle.props
		const selectedAgent = handle.props.selectedAgent ?? null
		const chooser = handle.props.chooser ?? canonicalOnboardingAgentChooser()
		const search = handle.props.search ?? ''
		handle.queueTask(() => {
			const hrefs = onboardingAgentPickerPrefetchHrefs(selectedAgent, chooser)
			const key = hrefs.join('\0')
			if (key === warmedKey) return
			warmedKey = key
			prefetchRouteHrefs(hrefs)
		})

		if (!selectedAgent) {
			return (
				<div data-testid="onboarding-agent-picker" mix={css(installLayoutCss)}>
					<p mix={css(pickerLedeCss)} id="onboarding-agent-picker-label">
						Choose the agent you want to connect first. You can add others
						later.
					</p>
					<AgentPickerGrid
						ids={[...onboardingPickerAgentIds(chooser), 'other']}
						labelledBy="onboarding-agent-picker-label"
						search={search}
					/>
				</div>
			)
		}

		if (selectedAgent === 'other') {
			return (
				<div
					data-testid="onboarding-agent-not-listed"
					mix={css(installLayoutCss)}
				>
					<p mix={css(pickerLedeCss)} id="onboarding-agent-not-listed-label">
						Any of these what you're looking for?
					</p>
					<AgentPickerGrid
						ids={onboardingNotListedAgentIds(chooser)}
						labelledBy="onboarding-agent-not-listed-label"
						search={search}
					/>
					<p mix={css(pickerLedeCss)} id="onboarding-agent-not-listed-generic">
						Or, connect any agent that speaks MCP
					</p>
					<div
						data-testid="onboarding-agent-instructions"
						data-agent="other"
						mix={css(installLayoutCss)}
					>
						<AgentSurfaceInstructions
							agent="other"
							mcpServerUrl={mcpServerUrl}
							highlights={highlights}
						/>
					</div>
				</div>
			)
		}

		return (
			<div
				data-testid="onboarding-agent-instructions"
				data-agent={selectedAgent}
				mix={css(installLayoutCss)}
			>
				<AgentSurfaceInstructions
					agent={selectedAgent}
					mcpServerUrl={mcpServerUrl}
					highlights={highlights}
				/>
			</div>
		)
	}
}

function AgentSurfaceInstructions(
	handle: Handle<{
		agent: McpClientKind
		mcpServerUrl: string
		highlights?: Record<string, HighlightedCode>
	}>,
) {
	return () => (
		<>
			<div
				data-surface="desktop"
				mix={css(onboardingViewportCss('desktop-only', 'grid'))}
			>
				<div mix={css(selectedPanelCss)}>
					{renderPanelContent(
						handle.props.agent,
						handle.props.mcpServerUrl,
						handle.props.highlights,
						'desktop',
					)}
					<AgentHelpLink agent={handle.props.agent} />
					{renderPanelWarning(handle.props.agent, 'desktop')}
				</div>
				<AgentAuthCallout agent={handle.props.agent} surface="desktop" />
			</div>
			<div
				data-surface="mobile"
				mix={css(onboardingViewportCss('mobile-only', 'grid'))}
			>
				<div mix={css(selectedPanelCss)}>
					{renderPanelContent(
						handle.props.agent,
						handle.props.mcpServerUrl,
						handle.props.highlights,
						'mobile',
					)}
					<AgentHelpLink agent={handle.props.agent} />
					{renderPanelWarning(handle.props.agent, 'mobile')}
				</div>
				<AgentAuthCallout agent={handle.props.agent} surface="mobile" />
			</div>
		</>
	)
}

function AgentPickerGrid(
	handle: Handle<{
		ids:
			| Array<McpClientKind>
			| Array<{ id: McpClientKind; viewport: OnboardingAgentViewport }>
		labelledBy: string
		search: string
	}>,
) {
	return () => (
		<ul aria-labelledby={handle.props.labelledBy} mix={css(pickerGridCss)}>
			{handle.props.ids.map((entry) => {
				const id = typeof entry === 'string' ? entry : entry.id
				const viewport =
					typeof entry === 'string'
						? onboardingAgentViewport(id)
						: entry.viewport
				const shown = viewport === 'none' ? 'both' : viewport
				return (
					<li key={id} mix={css(onboardingViewportCss(shown, 'list-item'))}>
						<a
							href={onboardingAgentHref(id, handle.props.search)}
							data-testid={`onboarding-agent-${id}`}
							data-prevent-scroll-reset=""
							mix={css(pickerCardCss)}
						>
							<AgentPickerMark agent={id} />
							<strong>
								<AgentSurfaceLabel agent={id} />
							</strong>
						</a>
					</li>
				)
			})}
		</ul>
	)
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
	alignItems: 'stretch',
	gridTemplateColumns: 'repeat(auto-fill, minmax(min(10.5rem, 100%), 1fr))',
	gap: '0.75rem',
}

const pickerCardCss = {
	display: 'grid',
	justifyItems: 'center',
	alignContent: 'center',
	gap: '0.55rem',
	width: '100%',
	height: '100%',
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

const pickerMarkCss = {
	display: 'grid',
	placeItems: 'center',
	flex: 'none',
	width: '1.75rem',
	height: '1.75rem',
	color: colors.text,
}

const pickerIconImgCss = {
	display: 'block',
	width: '1.75rem',
	height: '1.75rem',
	objectFit: 'contain' as const,
	'@media (prefers-color-scheme: dark)': {
		filter: 'invert(1)',
	},
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

const agentHelpCss = {
	// Beat `selectedPanelCss` `& > p { margin: 0 }` so this sits off the
	// authenticate banner.
	'&&': {
		margin: '0 0 1rem',
	},
	fontSize: typography.fontSize.sm,
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
