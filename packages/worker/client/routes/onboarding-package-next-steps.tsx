import { type Handle, css } from 'remix/ui'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { buildOnboardingPackageAuthoringPrompt } from '#universal/onboarding-examples.ts'
import {
	getAccentCalloutCss,
	hoverMq,
	primaryLinkCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	transitions,
	typography,
} from '#universal/styles/tokens.ts'

export function OnboardingPackageNextSteps(handle: Handle<{ kodyId: string }>) {
	return () => {
		const authoringPrompt = buildOnboardingPackageAuthoringPrompt(
			handle.props.kodyId,
		)
		return (
			<div mix={css(nextStepsCss)} data-testid="onboarding-package-next-steps">
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

				<a href="/guides/kody-factory" mix={css(factoryCardCss)}>
					<img
						src="/images/kody-factory-map.webp"
						width={627}
						height={627}
						loading="lazy"
						alt="Kody mapping the path from an idea to a reusable software package"
					/>
					<span>
						<em>See the whole factory</em>
						<strong>Your agent can create packages</strong>
						<small>
							Follow an idea through code, storage, triggers, and a reusable
							tool you own.
						</small>
					</span>
				</a>
			</div>
		)
	}
}

const nextStepsCss = {
	display: 'grid',
	gridTemplateColumns: 'minmax(0, 1.1fr) minmax(15rem, 0.9fr)',
	gap: '1rem',
	'@media (max-width: 720px)': {
		gridTemplateColumns: '1fr',
	},
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

const factoryCardCss = {
	display: 'grid',
	gridTemplateColumns: 'minmax(8rem, 0.8fr) minmax(0, 1.2fr)',
	alignItems: 'center',
	gap: '0.7rem',
	padding: '0.8rem',
	color: colors.text,
	textDecoration: 'none',
	border: `2px solid oklch(from ${colors.primary} l c h / 0.55)`,
	borderRadius: radius.card,
	background: `linear-gradient(145deg, oklch(from ${colors.primary} l c h / 0.16), ${colors.surface})`,
	overflow: 'hidden' as const,
	transition: `transform 180ms ${transitions.easeOut}, border-color 180ms ${transitions.easeOut}`,
	'& img': {
		width: '100%',
		height: 'auto',
		rotate: '-2deg',
	},
	'& > span': {
		display: 'grid',
		gap: '0.35rem',
	},
	'& em': {
		font: `700 0.72rem/1 ${typography.fontFamilyDisplay}`,
		fontStyle: 'normal',
		letterSpacing: '0.08em',
		textTransform: 'uppercase' as const,
		color: colors.primaryText,
	},
	'& strong': {
		font: `700 1.05rem/1.2 ${typography.fontFamilyDisplay}`,
	},
	'& small': {
		color: colors.textMuted,
		fontSize: '0.86rem',
		lineHeight: 1.45,
	},
	[hoverMq]: {
		'&:hover': {
			transform: 'translateY(-2px)',
			borderColor: colors.primary,
		},
	},
	'@media (max-width: 420px)': {
		gridTemplateColumns: '1fr',
		'& img': {
			width: 'min(12rem, 70%)',
			justifySelf: 'center',
		},
	},
}
