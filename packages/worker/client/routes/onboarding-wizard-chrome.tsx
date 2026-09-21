import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import {
	onboardingExplorePackagesLabel,
	onboardingWizardSteps,
	type OnboardingWizardStepNumber,
} from '#universal/onboarding-process.ts'
import { createOnboardingNextConfirmation } from '#client/routes/onboarding-next-confirmation.ts'
import { renderIcon } from '#universal/icon.tsx'
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
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'

export type OnboardingCelebrationState = {
	seenIncomplete: boolean
	celebrated: boolean
}

/**
 * Confetti arms only after this visit has seen the last step unfinished.
 * Loading a wizard that is already finished stays quiet.
 */
export function reduceOnboardingCelebration(
	state: OnboardingCelebrationState,
	lastStepComplete: boolean,
): OnboardingCelebrationState {
	if (!lastStepComplete) {
		return { seenIncomplete: true, celebrated: state.celebrated }
	}
	if (state.seenIncomplete && !state.celebrated) {
		return { seenIncomplete: true, celebrated: true }
	}
	return state
}

function stepIsComplete(
	step: OnboardingWizardStepNumber,
	flags: {
		hasMcpClient: boolean
		accessWin: boolean
		hasSecondMcpClient: boolean
	},
) {
	switch (step) {
		case 1:
			return flags.hasMcpClient
		case 2:
			return flags.accessWin
		case 3:
			return flags.hasSecondMcpClient
		default: {
			const exhaustive: never = step
			return exhaustive
		}
	}
}

function stepsRemainingLabel(completeCount: number, total: number) {
	const remaining = total - completeCount
	if (remaining <= 0) return 'All steps complete'
	if (remaining === 1) return '1 step left'
	return `${remaining} steps left`
}

type StepVisualState = 'complete' | 'current' | 'upcoming'

function stepVisualState(complete: boolean, active: boolean): StepVisualState {
	if (complete) return 'complete'
	if (active) return 'current'
	return 'upcoming'
}

export function WizardStepsNav(
	handle: Handle<{
		activeStep: OnboardingWizardStepNumber
		hasMcpClient: boolean
		accessWin: boolean
		hasSecondMcpClient: boolean
		stepHref: (step: OnboardingWizardStepNumber) => string
	}>,
) {
	let celebration: OnboardingCelebrationState = {
		seenIncomplete: false,
		celebrated: false,
	}
	return () => {
		const flags = {
			hasMcpClient: handle.props.hasMcpClient,
			accessWin: handle.props.accessWin,
			hasSecondMcpClient: handle.props.hasSecondMcpClient,
		}
		celebration = reduceOnboardingCelebration(
			celebration,
			flags.hasSecondMcpClient,
		)
		const steps = onboardingWizardSteps.map((step) => ({
			...step,
			complete: stepIsComplete(step.number, flags),
		}))
		const completeCount = steps.filter((step) => step.complete).length
		return (
			<nav
				id="onboarding-steps-nav"
				aria-label="Onboarding steps"
				data-testid="onboarding-stepper"
				mix={css(wizardStepsCss)}
			>
				<p
					role="status"
					data-testid="onboarding-steps-progress"
					mix={css(stepsProgressCss)}
				>
					{stepsRemainingLabel(completeCount, steps.length)}
				</p>
				<ol mix={css(stepperListCss)}>
					{steps.map((step, index) => {
						const state = stepVisualState(
							step.complete,
							handle.props.activeStep === step.number,
						)
						const previousComplete = steps[index - 1]?.complete === true
						return (
							<li key={step.number} mix={css(stepItemCss)}>
								{index > 0 ? (
									<span
										aria-hidden="true"
										data-step-connector={previousComplete ? 'filled' : 'open'}
										mix={css(stepConnectorCss)}
									/>
								) : null}
								<a
									href={handle.props.stepHref(step.number)}
									aria-current={
										handle.props.activeStep === step.number ? 'step' : undefined
									}
									data-testid={`onboarding-step-${step.number}`}
									data-step-state={state}
									data-prevent-scroll-reset=""
									mix={css(stepLinkCss)}
								>
									<span
										data-step-marker
										aria-hidden={step.complete ? 'true' : undefined}
										mix={css(markerCssFor(state))}
									>
										{step.complete
											? renderIcon('check', { size: '14' })
											: step.number}
									</span>
									{step.complete ? (
										<span mix={css(visuallyHiddenCss)}>{step.number}</span>
									) : null}
									<span data-step-label>{step.label}</span>
									{step.complete ? (
										<span mix={css(visuallyHiddenCss)}>Complete</span>
									) : null}
								</a>
							</li>
						)
					})}
				</ol>
				{celebration.celebrated ? (
					<div
						aria-hidden="true"
						data-testid="onboarding-stepper-confetti"
						mix={css(confettiHostCss)}
					>
						{confettiBits.map((bit, index) => (
							<span
								key={index}
								style={{
									'--confetti-x': bit.x,
									'--confetti-y': bit.y,
									'--confetti-delay': bit.delay,
									'--confetti-color': bit.color,
								}}
								mix={css(confettiBitCss)}
							/>
						))}
					</div>
				) : null}
			</nav>
		)
	}
}

/* Linear track: equal columns, a connector from one marker's center to the
   next, filled once the earlier step is done. */
const wizardStepsCss = {
	position: 'relative' as const,
	marginTop: 'clamp(2.2rem, 5vw, 3.2rem)',
	display: 'grid',
	gap: '0.85rem',
}

const stepsProgressCss = {
	margin: 0,
	font: `650 0.84rem/1.2 ${typography.fontFamilyBody}`,
	color: colors.textMuted,
}

const stepperListCss = {
	display: 'flex',
	listStyle: 'none',
	margin: 0,
	padding: 0,
}

const stepItemCss = {
	position: 'relative' as const,
	flex: '1 1 0',
	minWidth: 0,
	display: 'flex',
	justifyContent: 'center',
}

const stepConnectorCss = {
	position: 'absolute' as const,
	zIndex: 0,
	top: 'calc(0.875rem - 1px)',
	left: '-50%',
	width: '100%',
	height: '2px',
	backgroundColor: colors.border,
	'&[data-step-connector="filled"]': {
		backgroundColor: colors.primary,
	},
}

const stepLinkCss = {
	position: 'relative' as const,
	zIndex: 1,
	display: 'flex',
	flexDirection: 'column' as const,
	alignItems: 'center',
	gap: '0.4rem',
	minWidth: 0,
	maxWidth: '11rem',
	font: `550 0.82rem/1.25 ${typography.fontFamilyBody}`,
	textAlign: 'center' as const,
	textDecoration: 'none',
	color: colors.textMuted,
	borderRadius: radius.sm,
	'&:focus-visible': {
		outline: `2px solid ${colors.primary}`,
		outlineOffset: '3px',
	},
	'&[data-step-state="current"]': {
		color: colors.primaryText,
		fontWeight: 680,
	},
	'&[data-step-state="complete"]': {
		color: colors.text,
		fontWeight: 650,
	},
	'& [data-step-label]': {
		overflowWrap: 'break-word' as const,
	},
	[hoverMq]: {
		'&:hover': { color: colors.text },
	},
}

const stepMarkerCss = {
	display: 'grid',
	placeItems: 'center',
	width: '1.75rem',
	height: '1.75rem',
	borderRadius: '50%',
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.surface,
	color: colors.textMuted,
	fontWeight: 760,
	lineHeight: 1,
}

const stepMarkerCurrentCss = {
	...stepMarkerCss,
	borderColor: colors.primary,
	backgroundColor: `oklch(from ${colors.primary} l c h / 0.16)`,
	color: colors.primaryText,
}

/* Feedback (the check appearing) borrows the success-in pop. */
const wizardPopCss = {
	'@media (prefers-reduced-motion: no-preference)': {
		animation: `success-in 200ms ${transitions.easeOut} both`,
	},
}

const stepMarkerCompleteCss = {
	...stepMarkerCss,
	backgroundColor: colors.primary,
	borderColor: colors.primary,
	color: colors.onPrimary,
	...wizardPopCss,
}

function markerCssFor(state: StepVisualState) {
	switch (state) {
		case 'complete':
			return stepMarkerCompleteCss
		case 'current':
			return stepMarkerCurrentCss
		case 'upcoming':
			return stepMarkerCss
		default: {
			const exhaustive: never = state
			return exhaustive
		}
	}
}

const confettiBits: Array<{
	x: string
	y: string
	delay: string
	color: string
}> = [
	{ x: '-22px', y: '-34px', delay: '0ms', color: colors.primary },
	{ x: '8px', y: '-40px', delay: '40ms', color: colors.warning },
	{ x: '28px', y: '-22px', delay: '80ms', color: colors.primaryText },
	{ x: '-36px', y: '-12px', delay: '20ms', color: colors.warning },
	{ x: '18px', y: '-16px', delay: '110ms', color: colors.primary },
	{ x: '-8px', y: '-46px', delay: '60ms', color: colors.primaryText },
	{ x: '36px', y: '-36px', delay: '90ms', color: colors.warning },
	{ x: '-28px', y: '-40px', delay: '30ms', color: colors.primary },
]

const confettiHostCss = {
	position: 'absolute' as const,
	right: '12%',
	top: '1.6rem',
	width: 0,
	height: 0,
	pointerEvents: 'none' as const,
}

const confettiBitCss = {
	position: 'absolute' as const,
	left: 0,
	top: 0,
	width: '6px',
	height: '6px',
	borderRadius: radius.full,
	backgroundColor: 'var(--confetti-color)',
	opacity: 0,
	pointerEvents: 'none' as const,
	'@media (prefers-reduced-motion: reduce)': {
		display: 'none',
	},
	'@media (prefers-reduced-motion: no-preference)': {
		'@keyframes onboarding-confetti-burst': {
			'0%': { opacity: 1, transform: 'translate(0, 0) scale(1)' },
			'100%': {
				opacity: 0,
				transform: 'translate(var(--confetti-x), var(--confetti-y)) scale(0.5)',
			},
		},
		animation: `onboarding-confetti-burst 900ms ${transitions.easeOutValue} forwards`,
		animationDelay: 'var(--confetti-delay)',
	},
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
		/**
		 * Shown in Next's slot after a plugin/install or copy-command click,
		 * while that client is still connecting. Absent until that click.
		 */
		connectWaitLabel?: string | null
		/**
		 * Last wizard step: never render a disabled Next. Explore packages is
		 * the only trailing action — copy lives in the step card.
		 */
		lastStep?: {
			exploreHref: string
		}
	}>,
) {
	const nextConfirmation = createOnboardingNextConfirmation(handle)
	return () => {
		const previousStep =
			handle.props.activeStep > 1
				? ((handle.props.activeStep - 1) as OnboardingWizardStepNumber)
				: null
		const lastStepNumber =
			onboardingWizardSteps[onboardingWizardSteps.length - 1]?.number
		const nextStep =
			lastStepNumber != null && handle.props.activeStep < lastStepNumber
				? ((handle.props.activeStep + 1) as OnboardingWizardStepNumber)
				: null
		const { onBack, onNext, onSkip, skipLabel, lastStep, connectWaitLabel } =
			handle.props
		const requiresConnectionConfirmation =
			handle.props.confirmUnconnectedNext === true
		const nextLabels = nextConfirmation.getLabels(
			requiresConnectionConfirmation,
		)
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
					{connectWaitLabel ? (
						<div
							role="status"
							data-testid="onboarding-connect-wait"
							mix={css(wizardConnectWaitCss)}
						>
							<span mix={css(connectStatusSpinnerCss)} aria-hidden="true" />
							<span mix={css(visuallyHiddenCss)}>{connectWaitLabel}</span>
						</div>
					) : lastStep ? (
						<a
							href={lastStep.exploreHref}
							data-testid="onboarding-wizard-explore-packages"
							mix={css(wizardExploreLinkCss)}
						>
							{onboardingExplorePackagesLabel}
						</a>
					) : (
						<button
							type="button"
							disabled={!onNext && nextStep == null}
							aria-label={nextLabels.full}
							mix={[
								css(wizardNextButtonCss),
								...nextConfirmation.getButtonMix({
									confirm: requiresConnectionConfirmation,
									onNext: advance,
								}),
							]}
							data-testid="onboarding-wizard-next"
						>
							<span data-next-label="full" mix={css(wizardNextLabelFullCss)}>
								{nextLabels.full}
							</span>
							<span data-next-label="terse" mix={css(wizardNextLabelTerseCss)}>
								{nextLabels.terse}
							</span>
						</button>
					)}
				</div>
			</footer>
		)
	}
}

export function connectStatusContent(input: {
	connected: boolean
	connectedLabel: string
	waitingLabel: string
}) {
	// Return an array (no inter-element whitespace text nodes) so flex height
	// stays identical across sibling pills.
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
	return renderIcon('check', { size: '14' })
}

/* Connection status pill: dashed while the product polls for the grant,
   solid once the agent lands. Height is locked to the check/spinner so
   sibling pills stay the same size. */
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

/* The footer is the container. A named query can shorten Next without the
   button measuring its own label. */
const wizardNavContainerName = 'wizardNav'
const wizardNavNarrow = `@container ${wizardNavContainerName} (max-width: 36rem)`

/* Back / Next: the wizard's only fixed geography, so it never moves. */
const wizardNavCss = {
	display: 'flex',
	justifyContent: 'space-between',
	gap: '0.8rem',
	marginTop: '0.3rem',
	paddingTop: '1.1rem',
	borderTop: `1px solid ${colors.border}`,
	containerType: 'inline-size' as const,
	containerName: wizardNavContainerName,
}

const wizardNextLabelFullCss = {
	[wizardNavNarrow]: { display: 'none' },
}

const wizardNextLabelTerseCss = {
	display: 'none',
	[wizardNavNarrow]: { display: 'inline' },
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

const wizardNextButtonCss = {
	...getPillButtonCss(),
	minWidth: '6.5rem',
	...wizardButtonDisabledCss,
}

/* Same slot as Next, but it is a status, not a button. The tinted ring
   keeps it from looking pressable. */
const wizardConnectWaitCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	boxSizing: 'border-box' as const,
	minWidth: '6.5rem',
	padding: '0.95rem 1.7rem',
	borderRadius: radius.full,
	backgroundColor: `oklch(from ${colors.primary} l c h / 0.08)`,
	color: colors.primaryText,
	boxShadow: `inset 0 0 0 1.5px oklch(from ${colors.primary} l c h / 0.45)`,
	cursor: 'progress',
}

const wizardExploreLinkCss = {
	...getGhostButtonCss(),
	minWidth: '6.5rem',
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
