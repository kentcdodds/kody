import { type Handle, css } from 'remix/ui'
import { landingArtAttrs } from '#universal/landing-images.ts'
import {
	getPillButtonCss,
	hoverMq,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	transitions,
	typography,
} from '#universal/styles/tokens.ts'

export function OnboardingFactoryCard(_handle: Handle) {
	return () => (
		<a
			href="/guides/kody-factory"
			mix={css(factoryCardCss)}
			data-testid="onboarding-factory-card"
		>
			<img
				{...landingArtAttrs('kody-factory-map')}
				width={1024}
				height={1024}
				alt="Kody presenting a map of the software factory"
			/>
			<span mix={css(factoryCopyCss)}>
				<em>See the whole system</em>
				<strong>Your personal software factory</strong>
				<small>
					Follow an idea through packages, storage, triggers, and tools your
					agent can reuse.
				</small>
			</span>
			<span aria-hidden="true" mix={css(factoryArrowCss)}>
				→
			</span>
		</a>
	)
}

const factoryCardCss = {
	marginTop: 'clamp(1.4rem, 3vw, 2rem)',
	display: 'grid',
	gridTemplateColumns: 'clamp(6.5rem, 16vw, 9rem) minmax(0, 1fr) auto',
	alignItems: 'center',
	gap: 'clamp(0.8rem, 2vw, 1.25rem)',
	padding: '0.7rem clamp(0.8rem, 2vw, 1.2rem) 0.7rem 0.7rem',
	color: colors.text,
	textDecoration: 'none',
	border: `1.5px solid oklch(from ${colors.primary} l c h / 0.5)`,
	borderRadius: radius.card,
	background: `linear-gradient(105deg, oklch(from ${colors.primary} l c h / 0.16), ${colors.surface} 68%)`,
	overflow: 'hidden' as const,
	transition: `transform 180ms ${transitions.easeOut}, border-color 180ms ${transitions.easeOut}, box-shadow 180ms ${transitions.easeOut}`,
	'& > img': {
		display: 'block',
		width: '100%',
		height: 'auto',
		borderRadius: `calc(${radius.card} - 0.35rem)`,
	},
	[hoverMq]: {
		'&:hover': {
			transform: 'translateY(-2px)',
			borderColor: colors.primary,
			boxShadow: `0 12px 30px oklch(from ${colors.primary} l c h / 0.1)`,
		},
	},
	'@media (max-width: 520px)': {
		gridTemplateColumns: '5.5rem minmax(0, 1fr) 2.35rem',
	},
}

const factoryCopyCss = {
	display: 'grid',
	gap: '0.28rem',
	minWidth: 0,
	'& em': {
		font: `700 0.72rem/1 ${typography.fontFamilyDisplay}`,
		fontStyle: 'normal',
		letterSpacing: '0.08em',
		textTransform: 'uppercase' as const,
		color: colors.primaryText,
	},
	'& strong': {
		font: `720 clamp(1.05rem, 2vw, 1.28rem)/1.2 ${typography.fontFamilyDisplay}`,
		letterSpacing: '-0.01em',
	},
	'& small': {
		color: colors.textMuted,
		fontSize: '0.88rem',
		lineHeight: 1.4,
	},
}

const factoryArrowCss = {
	...getPillButtonCss(),
	display: 'grid',
	placeItems: 'center',
	width: '2.35rem',
	height: '2.35rem',
	padding: 0,
	fontSize: '1.25rem',
	lineHeight: 1,
}
