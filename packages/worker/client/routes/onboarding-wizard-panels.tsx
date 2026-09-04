import { type Handle, css, type MixValue } from 'remix/ui'
import { type HighlightedCode } from '#universal/highlighted-code.ts'
import { landingArtAttrs } from '#universal/landing-images.ts'
import { routes } from '#universal/routes.ts'
import {
	onboardingAccessFooterCopyValue,
	onboardingAccessPickerLede,
	onboardingAccessSelectedLede,
	onboardingAgentHref,
	onboardingCopyRemainingTasksLabel,
	onboardingExplorePackagesHref,
	onboardingServiceHref,
	onboardingUnconnectedNotice,
	onboardingUseKodyPromptForService,
	type OnboardingSessionMilestoneState,
	type OnboardingWizardStepNumber,
} from '#universal/onboarding-process.ts'
import {
	type OnboardingServiceChoice,
	type OnboardingServiceChooserPick,
	canonicalOnboardingServiceChooser,
	onboardingNotListedServiceId,
} from '#universal/onboarding-mcp-chooser.ts'
import { buildAuthLink } from '#client/auth-links.ts'
import {
	AgentPickerMark,
	OnboardingMcpClientTabs,
} from '#client/routes/onboarding-mcp-client-tabs.tsx'
import {
	type McpClientKind,
	type OnboardingAgentChooserPick,
	canonicalOnboardingAgentChooser,
} from '#client/routes/onboarding-mcp-clients.ts'
import { CopyCard } from '#client/routes/onboarding-mcp-client-cards.tsx'
import { OnboardingCustomServicePrompt } from '#client/routes/onboarding-custom-service-prompt.tsx'
import { OnboardingServiceDifficultyMeter } from '#client/routes/onboarding-service-difficulty-meter.tsx'
import { OnboardingSessionMilestones } from '#client/routes/onboarding-session-milestones.tsx'
import {
	OnboardingServicePicker,
	ServicePickerMark,
} from '#client/routes/onboarding-service-picker.tsx'
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
			<div mix={css(panelHeadCss)}>
				<div>
					<p mix={css(panelKickerCss)}>Step 1</p>
					<div mix={css(panelTitleRowCss)}>
						<h2 id="connect-title" tabIndex={-1} mix={css(panelTitleCss)}>
							{props.selectedAgentLabel
								? `Connect ${props.selectedAgentLabel}`
								: 'Connect your agent'}
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
									href={onboardingAgentHref(null, props.search ?? '')}
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
					src="/images/kody-mcp-plug.webp"
					width={627}
					height={627}
					loading="lazy"
					alt="Kody plugging a cable into a warmly glowing port on a laptop"
					style={{ '--tilt': '2deg' }}
					mix={css(panelArtCss)}
				/>
			</div>
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

function renderConnectAgentStatus(props: {
	loggedIn: boolean
	hasMcpClient: boolean
	selectedAgent: McpClientKind | null
	selectedAgentLabel: string | null
	search?: string
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
					connectedLabel: props.selectedAgentLabel
						? `${props.selectedAgentLabel} is connected`
						: 'You are connected',
					waitingLabel: 'Waiting for your agent to connect…',
				})}
			</div>
		)
	}
	if (!props.selectedAgent) return null
	if (!props.loggedIn) {
		const resumeHref = onboardingAgentHref(
			props.selectedAgent,
			props.search ?? '',
		)
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

type AccessPanelProps = StepNavigationProps & {
	entrance: MixValue
	hasMcpClient: boolean
	discoveryPrompt: string
	milestones: OnboardingSessionMilestoneState
	selectedService: OnboardingServiceChoice | null
	serviceChooser: OnboardingServiceChooserPick | null
	selectedAgentLabel: string | null
	customServiceName?: string
	onCustomServiceNameChange?: (name: string) => void
}

export function OnboardingAccessPanel(handle: Handle<AccessPanelProps>) {
	let customServiceName = handle.props.customServiceName ?? ''
	return () =>
		renderAccessPanel({
			...handle.props,
			customServiceName,
			onCustomServiceNameChange: (name) => {
				customServiceName = name
				handle.props.onCustomServiceNameChange?.(name)
				handle.update()
			},
		})
}

export function renderAccessPanel(props: AccessPanelProps) {
	const chooser = props.serviceChooser ?? canonicalOnboardingServiceChooser()
	const selectedService = props.hasMcpClient ? props.selectedService : null
	const customServiceName = props.customServiceName ?? ''
	const connectedPrompt = onboardingUseKodyPromptForService(selectedService)
	const footerCopyValue = onboardingAccessFooterCopyValue({
		hasMcpClient: props.hasMcpClient,
		selectedService,
		milestones: props.milestones,
		agentLabel: props.selectedAgentLabel,
	})
	const accessLede = selectedService
		? onboardingAccessSelectedLede(props.selectedAgentLabel)
		: onboardingAccessPickerLede
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
					<div mix={css(panelTitleRowCss)}>
						<h2 id="connect-mcp-title" tabIndex={-1} mix={css(panelTitleCss)}>
							Give Kody access
						</h2>
						{selectedService ? (
							<ServicePickerMark
								service={selectedService}
								testId="onboarding-service-title-mark"
							/>
						) : null}
					</div>
					<div
						data-testid="onboarding-service-selection-meta"
						mix={css(serviceSelectionMetaCss)}
						aria-hidden={selectedService ? undefined : 'true'}
					>
						<div mix={css(changeSelectionSlotCss)}>
							{selectedService ? (
								<a
									href={onboardingServiceHref(null, props.search ?? '')}
									data-testid="onboarding-service-change"
									data-prevent-scroll-reset=""
									mix={css(changeSelectionCss)}
								>
									Change selection
								</a>
							) : null}
						</div>
						<div mix={css(difficultySlotCss)}>
							{selectedService ? (
								<OnboardingServiceDifficultyMeter service={selectedService} />
							) : null}
						</div>
					</div>
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
			<p mix={css(panelLedeCss)} data-testid="onboarding-access-lede">
				{accessLede}
			</p>
			{props.hasMcpClient ? (
				selectedService === onboardingNotListedServiceId ? (
					<OnboardingCustomServicePrompt
						serviceName={customServiceName}
						onServiceNameChange={props.onCustomServiceNameChange}
					/>
				) : selectedService ? (
					<div
						data-testid="onboarding-connected-prompt"
						mix={css(promptBlockCss)}
					>
						<CopyCard
							label="Prompt"
							value={connectedPrompt}
							copyLabel="Copy prompt"
						/>
					</div>
				) : (
					<OnboardingServicePicker
						featuredIds={chooser.featured}
						overflowIds={chooser.overflow}
						search={props.search ?? ''}
					/>
				)
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
			{selectedService ? (
				<OnboardingSessionMilestones
					milestones={props.milestones}
					agentLabel={props.selectedAgentLabel}
				/>
			) : null}
			<WizardNavigation
				activeStep={props.activeStep}
				onSelectStep={props.onSelectStep}
				lastStep={{
					copyPrompt: footerCopyValue
						? {
								value: footerCopyValue,
								label: onboardingCopyRemainingTasksLabel,
							}
						: null,
					exploreHref: onboardingExplorePackagesHref(),
				}}
			/>
		</section>
	)
}

/* One panel at a time: a card that holds the whole step. */
const wizardPanelCss = {
	marginTop: '1rem',
	backgroundColor: colors.surface,
	border: `1.5px solid ${colors.border}`,
	borderRadius: radius.card,
	padding: 'clamp(1.4rem, 3.5vw, 2.2rem)',
	display: 'grid',
	gap: '1.15rem',
	/*
	 * Grid items floor at min-content, so one unbreakable child (a long URL, a
	 * wide code sample) would otherwise widen the whole panel and the page with
	 * it. Keep the column free to shrink and let the child wrap instead.
	 */
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

const serviceSelectionMetaCss = {
	...agentSelectionMetaCss,
	gap: '0.4rem',
	minHeight: '3.35rem',
}

const changeSelectionSlotCss = {
	display: 'grid',
	alignItems: 'center',
	minHeight: '1.25rem',
}

const difficultySlotCss = {
	display: 'grid',
	alignContent: 'start',
	minHeight: '1.7rem',
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

/* Placed by hand, not stamped by a grid. */
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
