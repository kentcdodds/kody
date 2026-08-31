import { type Handle, css } from 'remix/ui'
import {
	type McpClientKind,
	type OnboardingAgentChooserPick,
	type OnboardingAgentSurface,
	buildOnboardingAgentHref,
	canonicalOnboardingAgentChooser,
	codexMcpLoginCommand,
	onboardingAgentIconName,
	onboardingAgentLabel,
	onboardingFeaturedIdsFromChooser,
	onboardingMobileAgentMq,
	onboardingMoreIdsFromChooser,
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
	hoverMq,
} from '#universal/styles/style-primitives.ts'
import { type HighlightedCode } from '#universal/highlighted-code.ts'
import { renderPanelContent } from './onboarding-mcp-client-panels.tsx'

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
