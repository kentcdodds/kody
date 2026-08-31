import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import {
	onboardingWizardSteps,
	type OnboardingWizardStepNumber,
} from '#universal/onboarding-process.ts'
import { createOnboardingNextConfirmation } from '#client/routes/onboarding-next-confirmation.ts'
import {
	colors,
	radius,
	transitions,
	typography,
} from '#universal/styles/tokens.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
	hoverMq,
	inlineSpinnerCss,
} from '#universal/styles/style-primitives.ts'

export function renderWizardStepsNav(props: {
	activeStep: OnboardingWizardStepNumber
	hasMcpClient: boolean
	hasStep2Win: boolean
	stepHref: (step: OnboardingWizardStepNumber) => string
}) {
	return (
		<nav
			id="onboarding-steps-nav"
			aria-label="Onboarding steps"
			mix={css(wizardStepsCss)}
		>
			{onboardingWizardSteps.map((step) => {
				const isActive = props.activeStep === step.number
				const isComplete =
					(step.number === 1 && props.hasMcpClient) ||
					(step.number === 2 && props.hasStep2Win)
				return (
					<a
						key={step.number}
						href={props.stepHref(step.number)}
						aria-current={isActive ? 'step' : undefined}
						data-testid={`onboarding-step-${step.number}`}
						data-prevent-scroll-reset=""
						mix={css(stepButtonCss)}
					>
						<span data-wizard-num mix={css(stepNumberCss)}>
							{step.number}
						</span>
						<span>{step.label}</span>
						{isComplete ? (
							<span role="img" aria-label="Complete" mix={css(stepCheckCss)}>
								✓
							</span>
						) : null}
					</a>
				)
			})}
		</nav>
	)
}

/* Stepper: the sequence is the page's spine — each step is a live button,
   with the number in a lantern of its own. */
const wizardStepsCss = {
	marginTop: 'clamp(2.2rem, 5vw, 3.2rem)',
	display: 'grid',
	gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
	gap: '0.8rem',
	'@media (max-width: 900px)': {
		gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
	},
	'@media (max-width: 720px)': {
		gridTemplateColumns: '1fr',
		gap: '0.5rem',
	},
}

const stepButtonCss = {
	display: 'flex',
	alignItems: 'center',
	gap: '0.7rem',
	font: `550 0.98rem/1.25 ${typography.fontFamilyBody}`,
	textAlign: 'left' as const,
	textDecoration: 'none',
	color: colors.textMuted,
	backgroundColor: colors.surface,
	border: `1.5px solid ${colors.border}`,
	borderRadius: radius.card,
	padding: '0.8rem 1rem',
	cursor: 'pointer',
	transition: `border-color 160ms ${transitions.easeOut}, color 160ms ${transitions.easeOut}, scale 160ms ${transitions.easeOut}`,
	[hoverMq]: {
		'&:hover': {
			borderColor: colors.primary,
			color: colors.text,
		},
		'&:hover [data-wizard-num]': {
			backgroundColor: `oklch(from ${colors.primary} l c h / 0.26)`,
		},
	},
	'&[aria-current="step"]': {
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

const stepNumberCss = {
	flex: 'none',
	display: 'grid',
	placeItems: 'center',
	width: '2rem',
	height: '2rem',
	borderRadius: '50%',
	backgroundColor: `oklch(from ${colors.primary} l c h / 0.16)`,
	color: colors.primaryText,
	fontWeight: 760,
	transition: `background-color 160ms ${transitions.easeOut}`,
}

/* Feedback (checks appearing) borrows the waitlist's success-in pop. */
export const wizardPopCss = {
	'@media (prefers-reduced-motion: no-preference)': {
		animation: `success-in 200ms ${transitions.easeOut} both`,
	},
}

const stepCheckCss = {
	marginLeft: 'auto',
	color: colors.primaryText,
	fontWeight: 760,
	...wizardPopCss,
}

export function WizardNavigation(
	handle: Handle<{
		activeStep: OnboardingWizardStepNumber
		onSelectStep: (step: OnboardingWizardStepNumber) => void
		/** Optional overrides when a step owns custom Back/Next behavior. */
		onBack?: () => void
		onNext?: () => void
		confirmUnconnectedNext?: boolean
		skipLabel?: string
		onSkip?: () => void
	}>,
) {
	const nextConfirmation = createOnboardingNextConfirmation(handle)
	return () => {
		const previousStep =
			handle.props.activeStep > 1
				? ((handle.props.activeStep - 1) as OnboardingWizardStepNumber)
				: null
		const nextStep =
			handle.props.activeStep < 3
				? ((handle.props.activeStep + 1) as OnboardingWizardStepNumber)
				: null
		const { onBack, onNext, onSkip, skipLabel } = handle.props
		const requiresConnectionConfirmation =
			handle.props.confirmUnconnectedNext === true
		const advance = () => {
			if (onNext) return onNext()
			if (nextStep) handle.props.onSelectStep(nextStep)
		}

		return (
			<footer mix={css(wizardNavCss)}>
				<button
					type="button"
					disabled={!onBack && previousStep == null}
					mix={[
						css(wizardBackButtonCss),
						on('click', () => {
							if (onBack) return onBack()
							if (previousStep) handle.props.onSelectStep(previousStep)
						}),
					]}
				>
					Back
				</button>
				<div mix={css(wizardNavTrailingCss)}>
					{onSkip && skipLabel ? (
						<button
							type="button"
							mix={[css(wizardSkipButtonCss), on('click', onSkip)]}
							data-testid="onboarding-wizard-skip"
						>
							{skipLabel}
						</button>
					) : null}
					<button
						type="button"
						disabled={!onNext && nextStep == null}
						mix={[
							css(wizardNextButtonCss),
							...nextConfirmation.getButtonMix({
								confirm: requiresConnectionConfirmation,
								onNext: advance,
							}),
						]}
						data-testid="onboarding-wizard-next"
					>
						{nextConfirmation.getLabel(requiresConnectionConfirmation)}
					</button>
				</div>
			</footer>
		)
	}
}

export function Step2ConnectStatus(
	handle: Handle<{
		waiting: boolean
		connected: boolean
		exampleInstalled: boolean
		oauthError: string | null
		onNext: () => void
	}>,
) {
	return () => {
		const { waiting, connected, exampleInstalled, oauthError, onNext } =
			handle.props
		if (connected) {
			return (
				<div
					mix={css(step2ConnectedRowCss)}
					data-testid="onboarding-mcp-chooser-done"
				>
					<div
						mix={css(connectStatusCss)}
						role="status"
						aria-live="polite"
						data-connected="true"
					>
						{connectStatusContent({
							connected: true,
							connectedLabel: 'Connected',
							waitingLabel: 'Waiting for first connection…',
						})}
					</div>
					<button
						type="button"
						mix={[css(wizardNextButtonCss), on('click', onNext)]}
						data-testid="onboarding-mcp-connected-next"
					>
						Next
					</button>
				</div>
			)
		}
		if (oauthError) {
			return (
				<p mix={css(step2OAuthErrorCss)} role="alert">
					{oauthError}
				</p>
			)
		}
		if (waiting) {
			return (
				<div
					mix={css(connectStatusCss)}
					role="status"
					aria-live="polite"
					data-testid="onboarding-mcp-waiting"
				>
					{connectStatusContent({
						connected: false,
						connectedLabel: 'Connected',
						waitingLabel: 'Waiting for first connection…',
					})}
				</div>
			)
		}
		if (exampleInstalled) {
			return (
				<p mix={css(quickExampleDoneCss)} data-testid="onboarding-example-done">
					Installed — continue to try it and persist a package you own.
				</p>
			)
		}
		return null
	}
}

export function connectStatusContent(input: {
	connected: boolean
	connectedLabel: string
	waitingLabel: string
}) {
	// Return an array (no inter-element whitespace text nodes) so flex height
	// stays identical across sibling pills in the step-3 grid.
	if (input.connected) {
		return [
			<span key="check" mix={css(connectCheckCss)} aria-hidden="true">
				{connectedCheckIcon()}
			</span>,
			<strong key="label">{input.connectedLabel}</strong>,
		]
	}
	return [
		<span
			key="spinner"
			mix={css(connectStatusSpinnerCss)}
			aria-hidden="true"
		/>,
		<strong key="label">{input.waitingLabel}</strong>,
	]
}

function connectedCheckIcon() {
	return (
		<svg
			viewBox="0 0 16 16"
			width="14"
			height="14"
			aria-hidden="true"
			focusable={false}
			fill="none"
			stroke="currentColor"
			strokeWidth="1.8"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M3.4 8.2 6.5 11.2 12.6 4.8" />
		</svg>
	)
}

/* Connection status pill: dashed while the product polls for the grant,
   solid once the agent lands. Height is locked to the check/spinner so
   sibling pills in the step-3 grid stay the same size. */
export const connectStatusCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.55rem',
	width: 'fit-content',
	maxWidth: '100%',
	boxSizing: 'border-box' as const,
	color: colors.primaryText,
	backgroundColor: `oklch(from ${colors.primary} l c h / 0.08)`,
	border: `1.5px dashed oklch(from ${colors.primary} l c h / 0.45)`,
	borderRadius: '999px',
	padding: '0.35rem 0.95rem 0.35rem 0.4rem',
	lineHeight: 1,
	'&[data-connected]': {
		borderStyle: 'solid',
	},
	'& strong': {
		lineHeight: 1.2,
		fontWeight: 700,
	},
}

const connectCheckCss = {
	flex: 'none',
	display: 'grid',
	placeItems: 'center',
	boxSizing: 'border-box' as const,
	width: '1.5rem',
	height: '1.5rem',
	borderRadius: '50%',
	backgroundColor: colors.primary,
	color: colors.onPrimary,
	fontWeight: 760,
	lineHeight: 1,
	...wizardPopCss,
}

/** Match the check circle so waiting/connected pills share one height. */
const connectStatusSpinnerCss = {
	...inlineSpinnerCss,
	width: '1.5rem',
	height: '1.5rem',
}

export const quickExampleDoneCss = {
	margin: 0,
	color: colors.primaryText,
	fontWeight: 600,
}

const step2ConnectedRowCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'center',
	justifyContent: 'center',
	gap: '0.75rem 1rem',
	marginTop: '0.35rem',
}

const step2OAuthErrorCss = {
	margin: '0.35rem 0 0',
	color: colors.error,
	font: `550 0.9rem/1.45 ${typography.fontFamilyBody}`,
	textAlign: 'center' as const,
	textWrap: 'pretty' as const,
}

/* Back / Next: the wizard's only fixed geography, so it never moves. */
const wizardNavCss = {
	display: 'flex',
	justifyContent: 'space-between',
	gap: '0.8rem',
	marginTop: '0.3rem',
	paddingTop: '1.1rem',
	borderTop: `1px solid ${colors.border}`,
}

const wizardNavTrailingCss = {
	display: 'flex',
	justifyContent: 'flex-end',
	flexWrap: 'wrap' as const,
	gap: '0.6rem',
}

const wizardSkipButtonCss = {
	...getGhostButtonCss(),
	minWidth: '6.5rem',
}

const wizardButtonDisabledCss = {
	'&:disabled': {
		opacity: 0.45,
		cursor: 'not-allowed',
		transform: 'none',
		boxShadow: 'none',
	},
}

export const wizardNextButtonCss = {
	...getPillButtonCss(),
	minWidth: '6.5rem',
	...wizardButtonDisabledCss,
}

const wizardBackButtonCss = {
	...getGhostButtonCss(),
	minWidth: '6.5rem',
	...wizardButtonDisabledCss,
	'&:disabled': {
		...wizardButtonDisabledCss['&:disabled'],
		boxShadow: `inset 0 0 0 1.5px ${colors.border}`,
	},
}
