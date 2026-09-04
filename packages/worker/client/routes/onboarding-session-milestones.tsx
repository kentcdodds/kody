import { type Handle, css } from 'remix/ui'
import { writeClipboardText } from '#client/clipboard.ts'
import { on } from '#client/event-mixin.ts'
import {
	onboardingMilestonesHeading,
	onboardingSessionMilestonePrompt,
	onboardingSessionMilestones,
	type OnboardingSessionMilestoneId,
	type OnboardingSessionMilestoneState,
} from '#universal/onboarding-process.ts'
import {
	colors,
	radius,
	shadows,
	spacing,
	transitions,
	typography,
} from '#universal/styles/tokens.ts'
import { visuallyHiddenCss } from '#universal/styles/style-primitives.ts'

const milestoneStatusSlotSize = '1.25rem'

export function OnboardingSessionMilestones(
	handle: Handle<{
		milestones: OnboardingSessionMilestoneState
		agentLabel: string | null
	}>,
) {
	return () => (
		<div mix={css(milestonesWrapCss)}>
			<p
				data-testid="onboarding-milestones-heading"
				mix={css(milestonesHeadingCss)}
			>
				{onboardingMilestonesHeading(handle.props.agentLabel)}
			</p>
			<ol data-testid="onboarding-milestones" mix={css(milestoneListCss)}>
				{onboardingSessionMilestones.map((item) => {
					const done = handle.props.milestones[item.id]
					return (
						<li
							key={item.id}
							data-testid={`onboarding-milestone-${item.id}`}
							data-complete={done ? 'true' : 'false'}
							mix={css(milestoneListItemCss)}
						>
							{done ? (
								<div mix={css(milestoneItemCss)}>
									<span
										data-status-slot=""
										data-testid={`onboarding-milestone-${item.id}-check`}
										mix={css(milestoneCheckCss)}
										aria-hidden="true"
									>
										{milestoneCheckIcon()}
									</span>
									<span>{item.label}</span>
								</div>
							) : (
								<OnboardingMilestoneCopyButton
									milestoneId={item.id}
									label={item.label}
								/>
							)}
						</li>
					)
				})}
			</ol>
		</div>
	)
}

function OnboardingMilestoneCopyButton(
	handle: Handle<{
		milestoneId: OnboardingSessionMilestoneId
		label: string
	}>,
) {
	let copyState: 'idle' | 'copied' | 'error' = 'idle'
	let revealCopy = false
	let resetTimerId: ReturnType<typeof setTimeout> | null = null

	function setReveal(next: boolean) {
		if (revealCopy === next) return
		revealCopy = next
		handle.update()
	}

	async function copyPrompt() {
		try {
			await writeClipboardText(
				onboardingSessionMilestonePrompt(handle.props.milestoneId),
			)
			copyState = 'copied'
		} catch {
			copyState = 'error'
		}
		handle.update()
		if (resetTimerId != null) clearTimeout(resetTimerId)
		resetTimerId = setTimeout(() => {
			resetTimerId = null
			if (handle.signal.aborted) return
			copyState = 'idle'
			handle.update()
		}, 2000)
	}

	return () => {
		const showClipboard = revealCopy || copyState === 'copied'
		const tooltip =
			copyState === 'copied'
				? 'Prompt copied'
				: copyState === 'error'
					? 'Copy failed'
					: 'Copy prompt'
		const showTooltip = copyState !== 'idle' || revealCopy
		const tooltipId = `${handle.id}-tooltip`
		return (
			<button
				type="button"
				data-testid={`onboarding-milestone-${handle.props.milestoneId}-copy`}
				data-copy-state={copyState}
				data-reveal={showClipboard ? 'true' : undefined}
				aria-label={`Copy prompt for ${handle.props.label}`}
				aria-describedby={tooltipId}
				mix={[
					css(milestoneCopyButtonCss),
					on('click', () => void copyPrompt()),
					on('pointerenter', () => setReveal(true)),
					on('pointerleave', () => setReveal(false)),
					on('focus', () => setReveal(true)),
					on('blur', () => setReveal(false)),
				]}
			>
				<span data-status-slot="" mix={css(milestoneCopyStatusCss)}>
					<span
						mix={css(milestoneSpinnerCss)}
						data-icon="spinner"
						data-visible={showClipboard ? undefined : 'true'}
						aria-hidden="true"
					/>
					<span
						mix={css(milestoneClipboardCss)}
						data-icon="clipboard"
						data-visible={showClipboard ? 'true' : undefined}
						aria-hidden="true"
					>
						{milestoneClipboardIcon()}
					</span>
					<span
						id={tooltipId}
						role="tooltip"
						aria-hidden={showTooltip ? undefined : 'true'}
						data-visible={showTooltip ? 'true' : undefined}
					>
						{tooltip}
					</span>
				</span>
				<span>{handle.props.label}</span>
				<span
					id={`${handle.id}-copy-status`}
					role="status"
					mix={css(visuallyHiddenCss)}
				>
					{copyState === 'copied'
						? 'Prompt copied'
						: copyState === 'error'
							? 'Copy failed'
							: ''}
				</span>
			</button>
		)
	}
}

function milestoneCheckIcon() {
	return (
		<svg
			viewBox="0 0 16 16"
			width="12"
			height="12"
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

function milestoneClipboardIcon() {
	return (
		<svg
			viewBox="0 0 16 16"
			width="14"
			height="14"
			aria-hidden="true"
			focusable={false}
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<rect x="4.5" y="3.25" width="8.5" height="11" rx="1.4" />
			<path d="M6.25 3.25V2.6A1.1 1.1 0 0 1 7.35 1.5h3.3a1.1 1.1 0 0 1 1.1 1.1v.65" />
			<path d="M7 8h4M7 10.5h4" />
		</svg>
	)
}

const milestonesWrapCss = {
	display: 'grid',
	gap: '0.65rem',
}

const milestonesHeadingCss = {
	margin: 0,
	color: colors.textMuted,
	font: `550 0.95rem/1.4 ${typography.fontFamilyBody}`,
}

const milestoneListCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: '0.65rem',
}

const milestoneListItemCss = {
	margin: 0,
}

const milestoneItemCss = {
	display: 'grid',
	gridTemplateColumns: `${milestoneStatusSlotSize} 1fr`,
	alignItems: 'center',
	gap: '0.65rem',
	margin: 0,
	color: colors.text,
	font: `550 0.98rem/1.35 ${typography.fontFamilyBody}`,
}

const milestoneStatusSlotCss = {
	display: 'grid',
	placeItems: 'center',
	boxSizing: 'border-box' as const,
	width: milestoneStatusSlotSize,
	height: milestoneStatusSlotSize,
	flex: 'none',
	margin: 0,
	padding: 0,
}

const milestoneIconLayerCss = {
	gridArea: '1 / 1',
	display: 'grid',
	placeItems: 'center',
	boxSizing: 'border-box' as const,
	width: '100%',
	height: '100%',
}

const milestoneSpinnerCss = {
	...milestoneIconLayerCss,
	border: `1.5px solid ${colors.border}`,
	borderTopColor: colors.primary,
	borderRadius: radius.full,
	opacity: 0,
	'&[data-visible]': {
		opacity: 1,
	},
	'@keyframes inline-spinner-spin': {
		to: { transform: 'rotate(360deg)' },
	},
	'@media (prefers-reduced-motion: no-preference)': {
		animation: 'inline-spinner-spin 0.8s linear infinite',
	},
}

const milestoneCheckCss = {
	...milestoneStatusSlotCss,
	borderRadius: radius.full,
	backgroundColor: colors.primary,
	color: colors.onPrimary,
	'@media (prefers-reduced-motion: no-preference)': {
		animation: `success-in 200ms ${transitions.easeOut} both`,
	},
}

const milestoneClipboardCss = {
	...milestoneIconLayerCss,
	color: colors.primaryText,
	opacity: 0,
	'&[data-visible]': {
		opacity: 1,
	},
}

const milestoneCopyStatusCss = {
	...milestoneStatusSlotCss,
	position: 'relative' as const,
}

const milestoneCopyButtonCss = {
	...milestoneItemCss,
	appearance: 'none' as const,
	width: '100%',
	padding: 0,
	border: 0,
	background: 'transparent',
	textAlign: 'left' as const,
	cursor: 'pointer',
	borderRadius: radius.md,
	'&:focus-visible': {
		outline: `2px solid ${colors.primary}`,
		outlineOffset: '2px',
	},
	'& [role="tooltip"]': {
		position: 'absolute' as const,
		left: '50%',
		bottom: 'calc(100% + 0.4rem)',
		transform: 'translateX(-50%)',
		width: 'max-content',
		padding: `${spacing.xs} ${spacing.sm}`,
		borderRadius: radius.md,
		backgroundColor: colors.surface,
		color: colors.text,
		fontSize: typography.fontSize.xs,
		fontWeight: 550,
		lineHeight: 1.3,
		boxShadow: shadows.md,
		border: `1px solid ${colors.border}`,
		pointerEvents: 'none' as const,
		opacity: 0,
		visibility: 'hidden' as const,
		zIndex: 2,
	},
	'& [role="tooltip"][data-visible]': {
		opacity: 1,
		visibility: 'visible' as const,
	},
}
