import { type Handle, css } from 'remix/ui'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { buildOnboardingPackageAuthoringPrompt } from '#universal/onboarding-examples.ts'
import {
	getAccentCalloutCss,
	primaryLinkCss,
} from '#universal/styles/style-primitives.ts'
import { colors, typography } from '#universal/styles/tokens.ts'

export function OnboardingPackageNextSteps(handle: Handle<{ kodyId: string }>) {
	return () => {
		const authoringPrompt = buildOnboardingPackageAuthoringPrompt(
			handle.props.kodyId,
		)
		return (
			<div data-testid="onboarding-package-next-steps">
				<section mix={css(authoringCardCss)}>
					<p mix={css(kickerCss)}>This fork is yours</p>
					<h3>Make it your own — or create a new package</h3>
					<p>
						Your agent can edit this package, publish its next version, or help
						you build a completely new one. Start with the authoring guide, or
						copy the prompt and let your agent lead.
					</p>
					<div mix={css(authoringActionsCss)}>
						<a
							href="/guides/package-authoring"
							target="_blank"
							rel="noreferrer noopener"
							mix={css(primaryLinkCss)}
						>
							Read the package-authoring guide
						</a>
						<CopyTextButton
							value={authoringPrompt}
							idleLabel="Copy build prompt"
							variant="pill"
						/>
					</div>
				</section>
			</div>
		)
	}
}

const authoringCardCss = {
	...getAccentCalloutCss(),
	display: 'grid',
	alignContent: 'center',
	gap: '0.75rem',
	'& h3, & p': { margin: 0 },
	'& h3': {
		font: `700 1.2rem/1.2 ${typography.fontFamilyDisplay}`,
		color: colors.text,
	},
	'& > p:not(:first-child)': {
		color: colors.textMuted,
		lineHeight: 1.55,
	},
}

const kickerCss = {
	font: `700 0.75rem/1 ${typography.fontFamilyDisplay}`,
	letterSpacing: '0.09em',
	textTransform: 'uppercase' as const,
	color: colors.primaryText,
}

const authoringActionsCss = {
	display: 'flex',
	alignItems: 'center',
	flexWrap: 'wrap' as const,
	gap: '0.8rem 1rem',
}
