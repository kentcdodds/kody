import {
	hoverMq,
	layoutMaxWidths,
	pageGutter,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	shadows,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	siteBannerLookMinHeights,
	type SiteBannerIcon,
	type SiteBannerLook,
	type SiteBannerSeverity,
} from '#universal/site-banners.ts'

export type SiteBannerSeverityTone = {
	accent: string
	soft: string
	ink: string
}

export const siteBannerStackMq = '@media (max-width: 720px)'

export function siteBannerSeverityTone(
	severity: SiteBannerSeverity,
): SiteBannerSeverityTone {
	switch (severity) {
		case 'warning':
			return {
				accent: colors.warning,
				soft: `color-mix(in srgb, ${colors.warning} 16%, ${colors.surface})`,
				ink: colors.warningText,
			}
		case 'success':
			return {
				accent: colors.primary,
				soft: colors.primarySoft,
				ink: colors.primaryText,
			}
		case 'promo':
			return {
				accent: colors.primary,
				soft: colors.primarySoftStrong,
				ink: colors.primaryText,
			}
		case 'info':
			return {
				accent: colors.primary,
				soft: colors.primarySoftest,
				ink: colors.primaryText,
			}
		default: {
			const exhaustive: never = severity
			return exhaustive
		}
	}
}

export function defaultSiteBannerIcon(look: SiteBannerLook): SiteBannerIcon {
	switch (look) {
		case 'promo':
		case 'card':
			return 'play'
		case 'strip':
			return 'megaphone'
		default: {
			const exhaustive: never = look
			return exhaustive
		}
	}
}

export function siteBannerIconGlyph(icon: SiteBannerIcon) {
	switch (icon) {
		case 'play':
			return '▶'
		case 'megaphone':
			return '📣'
		case 'sparkle':
			return '✦'
		case 'info':
			return 'ℹ'
		default: {
			const exhaustive: never = icon
			return exhaustive
		}
	}
}

export function siteBannerShellCss(
	look: SiteBannerLook,
	tone: SiteBannerSeverityTone,
) {
	const minHeight = siteBannerLookMinHeights[look]
	const shared = {
		width: '100%',
		maxWidth: '100%',
		minWidth: 0,
		alignSelf: 'stretch' as const,
		margin: 0,
		boxSizing: 'border-box' as const,
		minHeight,
	}
	switch (look) {
		case 'strip':
			return {
				...shared,
				paddingBlock: '0.45rem',
				paddingInline: 0,
				borderBottom: `1px solid ${colors.border}`,
				backgroundColor: tone.soft,
			}
		case 'promo':
			return {
				...shared,
				paddingBlock: '0.85rem',
				paddingInline: 0,
				borderBottom: `1px solid ${colors.border}`,
				backgroundColor: tone.soft,
			}
		case 'card':
			return {
				...shared,
				padding: `${spacing.md} ${pageGutter}`,
				backgroundColor: colors.background,
			}
		default: {
			const exhaustive: never = look
			return exhaustive
		}
	}
}

export function siteBannerInnerCss(look: SiteBannerLook) {
	const shared = {
		width: '100%',
		margin: '0 auto',
		display: 'flex',
		alignItems: 'center',
		boxSizing: 'border-box' as const,
		position: 'relative' as const,
	}
	switch (look) {
		case 'strip':
			return {
				...shared,
				maxWidth: layoutMaxWidths.wide,
				paddingInline: pageGutter,
				gap: spacing.md,
				[siteBannerStackMq]: {
					flexWrap: 'wrap' as const,
					alignItems: 'flex-start',
					gap: spacing.sm,
					paddingInlineEnd: '1.75rem',
				},
			}
		case 'promo':
			return {
				...shared,
				maxWidth: layoutMaxWidths.extended,
				paddingInline: pageGutter,
				gap: spacing.lg,
				[siteBannerStackMq]: {
					flexWrap: 'wrap' as const,
					alignItems: 'flex-start',
					gap: spacing.md,
					paddingInlineEnd: '1.75rem',
				},
			}
		case 'card':
			return {
				...shared,
				maxWidth: layoutMaxWidths.content,
				gap: spacing.lg,
				padding: `${spacing.lg} ${spacing.xl}`,
				backgroundColor: colors.surface,
				border: `1px solid ${colors.border}`,
				borderRadius: radius.card,
				boxShadow: shadows.sm,
				[siteBannerStackMq]: {
					flexWrap: 'wrap' as const,
					alignItems: 'flex-start',
					gap: spacing.md,
					padding: spacing.md,
					paddingInlineEnd: '2rem',
				},
			}
		default: {
			const exhaustive: never = look
			return exhaustive
		}
	}
}

export function siteBannerCopyCss(look: SiteBannerLook) {
	return {
		display: 'grid',
		gap: look === 'strip' ? '0.1rem' : '0.25rem',
		flex: '1 1 16rem',
		minWidth: 0,
	}
}

export function siteBannerTitleCss(look: SiteBannerLook) {
	return {
		margin: 0,
		color: colors.text,
		fontFamily: typography.fontFamilyDisplay,
		fontWeight: typography.fontWeight.semibold,
		fontSize:
			look === 'strip'
				? typography.fontSize.sm
				: look === 'promo'
					? typography.fontSize.lg
					: typography.fontSize.xl,
		lineHeight: 1.25,
	}
}

export function siteBannerBodyCss(look: SiteBannerLook) {
	return {
		margin: 0,
		color: colors.textMuted,
		fontSize:
			look === 'strip' ? typography.fontSize.xs : typography.fontSize.sm,
		lineHeight: 1.4,
		[siteBannerStackMq]:
			look === 'strip'
				? {
						display: 'none',
					}
				: {},
	}
}

export function siteBannerActionsCss(look: SiteBannerLook) {
	return {
		display: 'flex',
		flexWrap: 'wrap' as const,
		alignItems: 'center',
		gap: spacing.sm,
		flex: look === 'strip' ? '0 1 auto' : '0 0 auto',
		[siteBannerStackMq]: {
			width: '100%',
		},
	}
}

export function siteBannerImagePixelSize(look: SiteBannerLook) {
	switch (look) {
		case 'card':
			return { width: 192, height: 108 }
		case 'promo':
			return { width: 160, height: 90 }
		case 'strip':
			return { width: 72, height: 40 }
		default: {
			const exhaustive: never = look
			return exhaustive
		}
	}
}

export function siteBannerImageCss(look: SiteBannerLook) {
	const width =
		look === 'card' ? '12rem' : look === 'promo' ? '10rem' : '4.5rem'
	return {
		width,
		aspectRatio: '16 / 9',
		height: 'auto',
		borderRadius: radius.md,
		objectFit: 'cover' as const,
		flex: '0 0 auto',
		backgroundColor: colors.surface,
		[siteBannerStackMq]:
			look === 'promo'
				? {
						width: '7rem',
					}
				: {},
	}
}

export function siteBannerIconWellCss(
	look: SiteBannerLook,
	tone: SiteBannerSeverityTone,
) {
	const size =
		look === 'card' ? '3.25rem' : look === 'promo' ? '2.75rem' : '1.75rem'
	return {
		width: size,
		height: size,
		flex: '0 0 auto',
		display: 'grid',
		placeItems: 'center',
		borderRadius: look === 'strip' ? radius.md : radius.full,
		backgroundColor: tone.accent,
		color: colors.onPrimary,
		fontSize: look === 'strip' ? '0.85rem' : '1.05rem',
		lineHeight: 1,
	}
}

export const siteBannerDismissCss = {
	position: 'absolute' as const,
	top: '0.15rem',
	right: '0.15rem',
	width: '1.75rem',
	height: '1.75rem',
	border: 'none',
	borderRadius: radius.full,
	backgroundColor: 'transparent',
	color: colors.textMuted,
	fontSize: '1.25rem',
	lineHeight: 1,
	cursor: 'pointer',
	[hoverMq]: {
		'&:hover': {
			backgroundColor: colors.primarySoftest,
			color: colors.text,
		},
	},
}
