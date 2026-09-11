import {
	layoutMaxWidths,
	pageGutter,
} from '#universal/styles/style-primitives.ts'
import { colors, typography } from '#universal/styles/tokens.ts'

/**
 * Shared layout for illustrated 404 / 500 pages. Keep the two pages on
 * this box so a copy or image tweak does not drift gutters or type.
 */
export const illustratedErrorPageCss = {
	boxSizing: 'border-box' as const,
	width: '100%',
	maxWidth: layoutMaxWidths.narrow,
	marginInline: 'auto',
	padding: `clamp(2rem, 6vw, 4rem) ${pageGutter} clamp(3rem, 8vw, 5rem)`,
	display: 'grid',
	justifyItems: 'center',
	textAlign: 'center' as const,
	gap: '1rem',
}

export const illustratedErrorImageCss = {
	width: 'min(18rem, 72vw)',
	height: 'auto',
	display: 'block',
}

/**
 * The 500 art is taller than it is wide (lightning around Kody's head).
 * Cap height so the heading and actions stay on a phone screen.
 */
export const illustratedErrorTallImageCss = {
	...illustratedErrorImageCss,
	width: 'min(16rem, 64vw)',
	maxHeight: 'min(24rem, 52vh)',
	objectFit: 'contain' as const,
}

export const illustratedErrorHeadingCss = {
	margin: '0.4rem 0 0',
	font: `700 clamp(1.6rem, 4vw, 2.1rem)/1.15 ${typography.fontFamilyDisplay}`,
	letterSpacing: '-0.02em',
	color: colors.text,
	textWrap: 'balance' as const,
}

export const illustratedErrorCopyCss = {
	margin: 0,
	maxWidth: '36rem',
	color: colors.textMuted,
	fontSize: '1.02rem',
	lineHeight: 1.5,
	textWrap: 'pretty' as const,
}

export const illustratedErrorActionsCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	justifyContent: 'center',
	gap: '0.7rem',
	marginTop: '0.6rem',
}
