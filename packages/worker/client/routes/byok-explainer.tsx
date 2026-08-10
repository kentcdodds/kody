import { css } from 'remix/ui'
import {
	colors,
	mq,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
} from '#universal/styles/style-primitives.ts'

const kodyImages = {
	keys: {
		src: '/images/kody-keys.webp',
		alt: 'Kody the koala proudly holding a set of golden keys',
	},
	handoff: {
		src: '/images/kody-hands-you-the-key.webp',
		alt: 'Kody the koala handing a golden key to you',
	},
} as const

const chipCss = {
	padding: `${spacing.xs} ${spacing.sm}`,
	borderRadius: radius.full,
	border: `1px solid ${colors.border}`,
	fontSize: typography.fontSize.sm,
	whiteSpace: 'nowrap' as const,
}

const diagramRowCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.xs,
	flexWrap: 'wrap' as const,
	margin: 0,
}

const diagramLabelCss = {
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.medium,
	color: colors.textMuted,
	minWidth: '6.5rem',
}

const diagramArrowCss = {
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

function renderDiagramChip(
	label: string,
	tone: 'plain' | 'their' | 'yours' = 'plain',
) {
	return (
		<span
			mix={css({
				...chipCss,
				...(tone === 'their'
					? {
							textDecoration: 'line-through',
							color: colors.textMuted,
							borderStyle: 'dashed',
						}
					: {}),
				...(tone === 'yours'
					? {
							borderColor: colors.primary,
							backgroundColor: colors.primarySoftest,
							color: colors.primaryText,
							fontWeight: typography.fontWeight.medium,
						}
					: {}),
			})}
		>
			{label}
		</span>
	)
}

/**
 * "Bring your own keys" pitch: why Kody has no built-in integrations.
 * Shared between onboarding and the integrations page so the story stays
 * consistent everywhere people expect a built-in integration catalog.
 */
export function renderByokExplainer(options?: {
	image?: keyof typeof kodyImages
}) {
	const image = kodyImages[options?.image ?? 'keys']

	return (
		<section aria-label="Bring your own keys" mix={css(cardCss)}>
			<div
				mix={css({
					display: 'grid',
					gridTemplateColumns: 'minmax(8rem, 11rem) minmax(0, 1fr)',
					gap: spacing.lg,
					alignItems: 'start',
					[mq.mobile]: {
						gridTemplateColumns: '1fr',
						justifyItems: 'center',
					},
				})}
			>
				<img
					src={image.src}
					alt={image.alt}
					width={640}
					height={640}
					mix={css({
						width: '100%',
						maxWidth: '11rem',
						height: 'auto',
						borderRadius: radius.lg,
						border: `1px solid ${colors.border}`,
					})}
				/>
				<div mix={css({ display: 'grid', gap: spacing.md })}>
					<div mix={css({ display: 'grid', gap: spacing.xs })}>
						<h2 mix={css(cardTitleCss)}>Bring your own keys</h2>
						<p mix={css(descriptionCss)}>
							Kody never asks a company for access on your behalf. You create
							the connection yourself — your agent walks you through it — so it
							is completely yours: your app, your scopes, no middleman.
						</p>
					</div>
					<div mix={css({ display: 'grid', gap: spacing.xs })}>
						<p mix={css(diagramRowCss)}>
							<span mix={css(diagramLabelCss)}>Typical apps</span>
							{renderDiagramChip('You')}
							<span aria-hidden="true" mix={css(diagramArrowCss)}>
								→
							</span>
							{renderDiagramChip('Their shared app', 'their')}
							<span aria-hidden="true" mix={css(diagramArrowCss)}>
								→
							</span>
							{renderDiagramChip('GitHub')}
						</p>
						<p mix={css(diagramRowCss)}>
							<span mix={css(diagramLabelCss)}>Kody</span>
							{renderDiagramChip('You')}
							<span aria-hidden="true" mix={css(diagramArrowCss)}>
								→
							</span>
							{renderDiagramChip('Your own app', 'yours')}
							<span aria-hidden="true" mix={css(diagramArrowCss)}>
								→
							</span>
							{renderDiagramChip('GitHub')}
						</p>
					</div>
					<ul
						mix={css({
							margin: 0,
							paddingLeft: spacing.lg,
							display: 'grid',
							gap: spacing.xs,
							color: colors.text,
						})}
					>
						<li>
							<strong>Your keys, your scopes.</strong> You decide exactly what
							Kody can touch, and you can revoke it anytime.
						</li>
						<li>
							<strong>No middleman.</strong> Nothing sits between you and the
							provider — no shared app to trust or get breached.
						</li>
						<li>
							<strong>No fixed list.</strong> If it has an API, your Kody can
							learn to use it.
						</li>
					</ul>
					<p mix={css(descriptionCss)}>
						The trade-off: a few minutes of setup instead of one click. Your
						agent does the tedious parts.
					</p>
				</div>
			</div>
		</section>
	)
}
