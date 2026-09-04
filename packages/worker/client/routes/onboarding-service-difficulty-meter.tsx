import { type Handle, css } from 'remix/ui'
import { type OnboardingServiceChoice } from '#universal/onboarding-mcp-chooser.ts'
import {
	onboardingServiceDifficulty,
	onboardingServiceDifficultyFilledCount,
} from '#universal/onboarding-service-difficulty.ts'
import { colors, radius, typography } from '#universal/styles/tokens.ts'

export function OnboardingServiceDifficultyMeter(
	handle: Handle<{
		service: OnboardingServiceChoice
	}>,
) {
	return () => {
		const level = onboardingServiceDifficulty(handle.props.service)
		if (level == null) return null
		const filled = onboardingServiceDifficultyFilledCount(level)
		return (
			<div
				data-testid="onboarding-service-difficulty"
				data-level={level}
				aria-label={`Easiest setup: ${level}`}
				mix={css(meterCss)}
			>
				<div aria-hidden="true" mix={css(pillsCss)}>
					{([1, 2, 3] as const).map((slot) => (
						<span
							key={slot}
							data-filled={slot <= filled ? 'true' : 'false'}
							data-level={level}
							mix={css(pillCss)}
						/>
					))}
				</div>
				<p data-level={level} mix={css(labelCss)}>
					{level}
				</p>
			</div>
		)
	}
}

/**
 * Fill rule: easy = 1, medium = 2, hard = 3 (`slot <= filledCount`).
 * Fill and label colors sit on the same element as `data-filled` /
 * `data-level` so Remix `css()` attribute selectors apply.
 */
const meterCss = {
	display: 'grid',
	justifyItems: 'start',
	gap: '0.28rem',
	width: 'fit-content',
}

const pillsCss = {
	display: 'flex',
	gap: '0.2rem',
	width: 'fit-content',
}

const pillCss = {
	display: 'block',
	width: '1.05rem',
	height: '0.38rem',
	borderRadius: radius.full,
	backgroundColor: colors.border,
	'&[data-filled="true"][data-level="easy"]': {
		backgroundColor: colors.primary,
	},
	'&[data-filled="true"][data-level="medium"]': {
		backgroundColor: colors.warning,
	},
	'&[data-filled="true"][data-level="hard"]': {
		backgroundColor: colors.danger,
	},
}

const labelCss = {
	margin: 0,
	font: `650 ${typography.fontSize.xs}/1 ${typography.fontFamilyDisplay}`,
	letterSpacing: '0.04em',
	color: colors.textMuted,
	'&[data-level="easy"]': { color: colors.primaryText },
	'&[data-level="medium"]': { color: colors.warningText },
	'&[data-level="hard"]': { color: colors.danger },
}
