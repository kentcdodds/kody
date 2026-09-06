import { css, type MixValue } from 'remix/ui'
import { type HighlightedCode } from '#universal/highlighted-code.ts'
import { landingArtAttrs } from '#universal/landing-images.ts'
import { routes } from '#universal/routes.ts'
import {
	onboardingAccessLede,
	onboardingAccessSelectedLede,
	onboardingAgentHref,
	onboardingCopyPortabilityProofLabel,
	onboardingExplorePackagesHref,
	onboardingPortabilityProofPrompt,
	onboardingSearchStartedLabel,
	onboardingSearchWaitingLabel,
	onboardingSecondAgentHref,
	onboardingSecondAgentLede,
	onboardingUnconnectedNotice,
	type OnboardingWizardStepNumber,
} from '#universal/onboarding-process.ts'
import { onboardingSameEcosystemDisabledReason } from '#universal/onboarding-agent-ecosystems.ts'
import { buildAuthLink } from '#client/auth-links.ts'
import {
	AgentPickerMark,
	OnboardingMcpClientTabs,
} from '#client/routes/onboarding-mcp-client-tabs.tsx'
import {
	type McpClientKind,
	type OnboardingAgentChooserPick,
	canonicalOnboardingAgentChooser,
	onboardingAgentLabel,
} from '#client/routes/onboarding-mcp-clients.ts'
import { CopyCard } from '#client/routes/onboarding-mcp-client-cards.tsx'
import { OnboardingStep2Prompt } from '#client/routes/onboarding-step-2-prompt.tsx'
import {
	WizardNavigation,
	connectStatusContent,
	connectStatusCss,
} from '#client/routes/onboarding-wizard-chrome.tsx'
import { colors, radius, typography } from '#universal/styles/tokens.ts'
import {
	getPillButtonCss,
	primaryLinkCss,
} from '#universal/styles/style-primitives.ts'

type StepNavigationProps = {
	activeStep: OnboardingWizardStepNumber
	onSelectStep: (step: OnboardingWizardStepNumber) => void
	search?: string
}

export function renderConnectAgentPanel(
	props: StepNavigationProps & {
		entrance: MixValue
		loggedIn: boolean
		hasMcpClient: boolean
		selectedAgent: McpClientKind | null
		selectedAgentLabel: string | null
		agentChooser: OnboardingAgentChooserPick | null
		mcpServerUrl: string
		mcpHighlights: Record<string, HighlightedCode>
	},
) {
	return (
		<section
			id="onboarding-step-1"
			aria-labelledby="connect-title"
			data-testid="onboarding-connect-agent"
			mix={[css(wizardPanelCss), props.entrance]}
		>
			{renderAgentPanelHead({
				kicker: 'Step 1',
				titleId: 'connect-title',
				title: props.selectedAgentLabel
					? `Connect ${props.selectedAgentLabel}`
					: 'Connect your agent',
				selectedAgent: props.selectedAgent,
				changeHref: onboardingAgentHref(null, props.search ?? ''),
				artSrc: '/images/kody-mcp-plug.webp',
				artAlt: 'Kody plugging a cable into a warmly glowing port on a laptop',
				tilt: '2deg',
			})}
			{renderConnectAgentStatus(props)}
			<OnboardingMcpClientTabs
				mcpServerUrl={props.mcpServerUrl}
				highlights={props.mcpHighlights}
				selectedAgent={props.selectedAgent}
				chooser={props.agentChooser ?? canonicalOnboardingAgentChooser()}
				search={props.search ?? ''}
			/>
			<WizardNavigation
				activeStep={props.activeStep}
				onSelectStep={props.onSelectStep}
				confirmUnconnectedNext={!props.hasMcpClient}
			/>
		</section>
	)
}

export function renderAccessPanel(
	props: StepNavigationProps & {
		entrance: MixValue
		hasMcpClient: boolean
		hasAccessWin: boolean
		discoveryPrompt: string
		selectedAgentLabel: string | null
	},
) {
	const accessLede = props.hasMcpClient
		? onboardingAccessSelectedLede(props.selectedAgentLabel)
		: onboardingAccessLede
	return (
		<section
			id="onboarding-step-2"
			aria-labelledby="connect-mcp-title"
			data-testid="onboarding-connect-mcp"
			mix={[css(wizardPanelCss), props.entrance]}
		>
			<div mix={css(panelHeadCss)}>
				<div>
					<p mix={css(panelKickerCss)}>Step 2</p>
					<h2 id="connect-mcp-title" tabIndex={-1} mix={css(panelTitleCss)}>
						Make something useful
					</h2>
				</div>
				<img
					data-panel-art
					{...landingArtAttrs('kody-community-packages')}
					width={627}
					height={627}
					alt="Kody kneeling beside a stack of parcels, one open and glowing with a eucalyptus sprig"
					style={{ '--tilt': '1.5deg' }}
					mix={css(panelArtCss)}
				/>
			</div>
			{props.hasMcpClient ? (
				<div
					mix={css(connectStatusCss)}
					role="status"
					aria-live="polite"
					data-testid="onboarding-search-status"
					data-connected={props.hasAccessWin ? 'true' : undefined}
				>
					{connectStatusContent({
						connected: props.hasAccessWin,
						connectedLabel: onboardingSearchStartedLabel,
						waitingLabel: onboardingSearchWaitingLabel,
					})}
				</div>
			) : null}
			<p mix={css(panelLedeCss)} data-testid="onboarding-access-lede">
				{accessLede}
			</p>
			{props.hasMcpClient ? (
				<OnboardingStep2Prompt />
			) : (
				<div
					data-testid="onboarding-unconnected-prompt"
					mix={css(promptBlockCss)}
				>
					<p mix={css(unconnectedNoticeCss)}>{onboardingUnconnectedNotice}</p>
					{props.discoveryPrompt ? (
						<CopyCard
							label="Discovery prompt"
							value={props.discoveryPrompt}
							copyLabel="Copy the discovery prompt"
						/>
					) : null}
				</div>
			)}
			<WizardNavigation
				activeStep={props.activeStep}
				onSelectStep={props.onSelectStep}
			/>
		</section>
	)
}

export function renderSecondAgentPanel(
	props: StepNavigationProps & {
		entrance: MixValue
		loggedIn: boolean
		hasSecondMcpClient: boolean
		firstAgent: McpClientKind | null
		selectedAgent: McpClientKind | null
		selectedAgentLabel: string | null
		greyedAgents: ReadonlyArray<McpClientKind>
		agentChooser: OnboardingAgentChooserPick | null
		mcpServerUrl: string
		mcpHighlights: Record<string, HighlightedCode>
	},
) {
	const firstLabel = props.firstAgent
		? onboardingAgentLabel(props.firstAgent)
		: 'your first agent'
	const greyedReason = props.firstAgent
		? onboardingSameEcosystemDisabledReason(props.firstAgent, firstLabel)
		: null
	return (
		<section
			id="onboarding-step-3"
			aria-labelledby="connect-second-title"
			data-testid="onboarding-connect-second-agent"
			mix={[css(wizardPanelCss), props.entrance]}
		>
			{renderAgentPanelHead({
				kicker: 'Step 3',
				titleId: 'connect-second-title',
				title: props.selectedAgentLabel
					? `Connect ${props.selectedAgentLabel}`
					: 'Connect a second agent',
				selectedAgent: props.selectedAgent,
				changeHref: onboardingSecondAgentHref(null, props.search ?? ''),
				artSrc: '/images/kody-mcp-plug.webp',
				artAlt: 'Kody plugging a cable into a warmly glowing port on a laptop',
				tilt: '-1.5deg',
			})}
			{props.selectedAgent ? (
				<p mix={css(panelLedeCss)} data-testid="onboarding-second-agent-lede">
					{onboardingSecondAgentLede}
				</p>
			) : null}
			{renderConnectAgentStatus({
				loggedIn: props.loggedIn,
				hasMcpClient: props.hasSecondMcpClient,
				selectedAgent: props.selectedAgent,
				selectedAgentLabel: props.selectedAgentLabel,
				search: props.search,
				loginHref: onboardingSecondAgentHref(
					props.selectedAgent,
					props.search ?? '',
				),
				connectedLabel: props.selectedAgentLabel
					? `${props.selectedAgentLabel} is connected`
					: 'Second agent is connected',
			})}
			<OnboardingMcpClientTabs
				mcpServerUrl={props.mcpServerUrl}
				highlights={props.mcpHighlights}
				selectedAgent={props.selectedAgent}
				chooser={props.agentChooser ?? canonicalOnboardingAgentChooser()}
				search={props.search ?? ''}
				agentHref={onboardingSecondAgentHref}
				pickerLede={onboardingSecondAgentLede}
				greyedAgents={props.greyedAgents}
				greyedReason={greyedReason}
			/>
			{props.selectedAgent ? (
				<div
					data-testid="onboarding-portability-proof"
					mix={css(promptBlockCss)}
				>
					<p mix={css(proofLedeCss)}>
						After it connects, paste this in the new agent. Reuse the memory,
						package, or ask you made in Step 2 — one short proof that Kody
						travels.
					</p>
					<CopyCard
						label="Portability proof"
						value={onboardingPortabilityProofPrompt}
						copyLabel={onboardingCopyPortabilityProofLabel}
					/>
				</div>
			) : null}
			<WizardNavigation
				activeStep={props.activeStep}
				onSelectStep={props.onSelectStep}
				lastStep={{
					copyPrompt: props.selectedAgent
						? {
								value: onboardingPortabilityProofPrompt,
								label: onboardingCopyPortabilityProofLabel,
							}
						: null,
					exploreHref: onboardingExplorePackagesHref(),
				}}
			/>
		</section>
	)
}

function renderAgentPanelHead(props: {
	kicker: string
	titleId: string
	title: string
	selectedAgent: McpClientKind | null
	changeHref: string
	artSrc: string
	artAlt: string
	tilt: string
}) {
	return (
		<div mix={css(panelHeadCss)}>
			<div>
				<p mix={css(panelKickerCss)}>{props.kicker}</p>
				<div mix={css(panelTitleRowCss)}>
					<h2 id={props.titleId} tabIndex={-1} mix={css(panelTitleCss)}>
						{props.title}
					</h2>
					{props.selectedAgent ? (
						<AgentPickerMark
							agent={props.selectedAgent}
							testId="onboarding-agent-title-mark"
						/>
					) : null}
				</div>
				<div
					data-testid="onboarding-agent-selection-meta"
					mix={css(agentSelectionMetaCss)}
					aria-hidden={props.selectedAgent ? undefined : 'true'}
				>
					<div mix={css(changeSelectionSlotCss)}>
						{props.selectedAgent ? (
							<a
								href={props.changeHref}
								data-testid="onboarding-agent-change"
								data-prevent-scroll-reset=""
								mix={css(changeSelectionCss)}
							>
								Change selection
							</a>
						) : null}
					</div>
				</div>
			</div>
			<img
				data-panel-art
				src={props.artSrc}
				width={627}
				height={627}
				loading="lazy"
				alt={props.artAlt}
				style={{ '--tilt': props.tilt }}
				mix={css(panelArtCss)}
			/>
		</div>
	)
}

function renderConnectAgentStatus(props: {
	loggedIn: boolean
	hasMcpClient: boolean
	selectedAgent: McpClientKind | null
	selectedAgentLabel: string | null
	search?: string
	loginHref?: string
	connectedLabel?: string
}) {
	if (props.hasMcpClient) {
		return (
			<div
				mix={css(connectStatusCss)}
				role="status"
				aria-live="polite"
				data-connected="true"
			>
				{connectStatusContent({
					connected: true,
					connectedLabel:
						props.connectedLabel ??
						(props.selectedAgentLabel
							? `${props.selectedAgentLabel} is connected`
							: 'You are connected'),
					waitingLabel: 'Waiting for your agent to connect…',
				})}
			</div>
		)
	}
	if (!props.selectedAgent) return null
	if (!props.loggedIn) {
		const resumeHref =
			props.loginHref ??
			onboardingAgentHref(props.selectedAgent, props.search ?? '')
		return (
			<a
				href={buildAuthLink(routes.login.href(), resumeHref)}
				data-testid="onboarding-agent-login"
				mix={css(agentLoginCss)}
			>
				{props.selectedAgentLabel
					? `Log in to connect ${props.selectedAgentLabel}`
					: 'Log in to connect'}
			</a>
		)
	}
	return (
		<div mix={css(connectStatusCss)} role="status" aria-live="polite">
			{connectStatusContent({
				connected: false,
				connectedLabel: 'You are connected',
				waitingLabel: props.selectedAgentLabel
					? `Waiting for ${props.selectedAgentLabel} to connect…`
					: 'Waiting for your agent to connect…',
			})}
		</div>
	)
}

const wizardPanelCss = {
	marginTop: '1rem',
	backgroundColor: colors.surface,
	border: `1.5px solid ${colors.border}`,
	borderRadius: radius.card,
	padding: 'clamp(1.4rem, 3.5vw, 2.2rem)',
	display: 'grid',
	gap: '1.15rem',
	minWidth: 0,
	'& > *': { minWidth: 0 },
}

const panelHeadCss = {
	display: 'flex',
	justifyContent: 'space-between',
	alignItems: 'center',
	gap: '1rem',
	overflow: 'visible',
	'@media (max-width: 720px)': {
		flexDirection: 'column-reverse' as const,
		alignItems: 'flex-start',
	},
}

const panelKickerCss = {
	margin: '0 0 0.35rem',
	font: `700 0.78rem/1 ${typography.fontFamilyDisplay}`,
	textTransform: 'uppercase' as const,
	letterSpacing: '0.09em',
	color: colors.primaryText,
}

const panelTitleRowCss = {
	display: 'flex',
	alignItems: 'center',
	gap: '0.65rem',
	flexWrap: 'wrap' as const,
}

const panelTitleCss = {
	margin: 0,
	fontSize: 'clamp(1.4rem, 2.4vw, 1.75rem)',
	fontWeight: 720,
	letterSpacing: '-0.018em',
	lineHeight: 1.15,
}

const agentSelectionMetaCss = {
	display: 'grid',
	justifyItems: 'start',
	width: 'fit-content',
	marginTop: '0.35rem',
	minHeight: '1.25rem',
}

const changeSelectionSlotCss = {
	display: 'grid',
	alignItems: 'center',
	minHeight: '1.25rem',
}

const changeSelectionCss = {
	...primaryLinkCss,
	display: 'inline-block',
	fontSize: typography.fontSize.sm,
}

const agentLoginCss = {
	...getPillButtonCss({ size: 'sm' }),
	width: 'fit-content',
}

const panelArtCss = {
	flex: 'none',
	width: 'clamp(90px, 11vw, 130px)',
	height: 'auto',
	rotate: 'var(--tilt, 0deg)',
	margin: '-0.4rem 0 -1.4rem',
	'@media (max-width: 720px)': {
		width: 'min(34%, 130px)',
		margin: '-0.4rem 0 0',
		alignSelf: 'flex-end',
	},
}

const panelLedeCss = {
	margin: 0,
	color: colors.textMuted,
	maxWidth: '68ch',
}

const proofLedeCss = {
	...panelLedeCss,
	fontWeight: 550,
	color: colors.text,
}

const promptBlockCss = {
	display: 'grid',
	gap: '0.75rem',
	width: '100%',
	maxWidth: '68ch',
	justifyItems: 'stretch',
}

const unconnectedNoticeCss = {
	margin: 0,
	color: colors.text,
	fontWeight: 650,
}
