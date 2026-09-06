import { type Handle, css } from 'remix/ui'
import { CopyCard } from '#client/routes/onboarding-mcp-client-cards.tsx'
import {
	onboardingCopyStep2PromptLabel,
	onboardingGuideHref,
	onboardingStep2Prompt,
} from '#universal/onboarding-process.ts'
import { colors, typography } from '#universal/styles/tokens.ts'
import { primaryLinkCss } from '#universal/styles/style-primitives.ts'

export function OnboardingStep2Prompt(_handle: Handle) {
	return () => (
		<div data-testid="onboarding-step-2-prompt" mix={css(listCss)}>
			<CopyCard
				label="Step 2 prompt"
				value={onboardingStep2Prompt}
				copyLabel={onboardingCopyStep2PromptLabel}
			/>
			<p mix={css(guidePointerCss)} data-testid="onboarding-guide-pointer">
				Depth lives in the{' '}
				<a href={onboardingGuideHref} mix={css(guideLinkCss)}>
					onboarding guide
				</a>
				. The prompt tells your agent to retrieve it.
			</p>
		</div>
	)
}

const listCss = {
	display: 'grid',
	gap: '0.85rem',
	width: '100%',
	maxWidth: '68ch',
	justifyItems: 'stretch',
}

const guidePointerCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

const guideLinkCss = {
	...primaryLinkCss,
	fontWeight: 600,
}
