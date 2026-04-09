import {
	colors,
	mq,
	radius,
	shadows,
	spacing,
	transitions,
	typography,
} from '#client/styles/tokens.ts'

type ButtonCssOptions = {
	size?: 'md' | 'lg'
	weight?: keyof typeof typography.fontWeight
	mobileFullWidth?: boolean
}

function getBaseButtonCss(options: ButtonCssOptions = {}) {
	const size = options.size ?? 'md'
	const weight = options.weight ?? 'medium'

	return {
		padding: `${spacing.sm} ${size === 'lg' ? spacing.lg : spacing.md}`,
		borderRadius: radius.full,
		fontSize: typography.fontSize.base,
		fontWeight: typography.fontWeight[weight],
		cursor: 'pointer',
		transition: `transform ${transitions.fast}, background-color ${transitions.normal}, border-color ${transitions.normal}, opacity ${transitions.normal}`,
		'&:disabled': {
			cursor: 'not-allowed',
			opacity: 0.7,
		},
		...(options.mobileFullWidth
			? {
					[mq.mobile]: {
						width: '100%',
					},
				}
			: {}),
	}
}

export function getPrimaryButtonCss(options?: ButtonCssOptions) {
	return {
		...getBaseButtonCss(options),
		border: 'none',
		backgroundColor: colors.primary,
		color: colors.onPrimary,
		'&:not(:disabled):hover': {
			backgroundColor: colors.primaryHover,
			transform: 'translateY(-1px)',
		},
		'&:not(:disabled):active': {
			backgroundColor: colors.primaryActive,
			transform: 'translateY(0)',
		},
	}
}

export function getSecondaryButtonCss(options?: ButtonCssOptions) {
	return {
		...getBaseButtonCss(options),
		border: `1px solid ${colors.border}`,
		backgroundColor: 'transparent',
		color: colors.text,
		'&:not(:disabled):hover': {
			backgroundColor: colors.primarySoftest,
			borderColor: colors.primary,
			transform: 'translateY(-1px)',
		},
		'&:not(:disabled):active': {
			backgroundColor: colors.primarySoft,
			transform: 'translateY(0)',
		},
	}
}

export function getDangerButtonCss(options?: ButtonCssOptions) {
	return {
		...getBaseButtonCss(options),
		border: 'none',
		backgroundColor: colors.danger,
		color: colors.onDanger,
		'&:not(:disabled):hover': {
			backgroundColor: colors.dangerHover,
			transform: 'translateY(-1px)',
		},
		'&:not(:disabled):active': {
			backgroundColor: colors.danger,
			transform: 'translateY(0)',
		},
	}
}

export const stackedPageCss = {
	display: 'grid',
	gap: spacing.lg,
}

export const pageHeaderCss = {
	display: 'grid',
	gap: spacing.xs,
}

export const pageEyebrowCss = {
	fontSize: typography.fontSize.xs,
	letterSpacing: '0.12em',
	textTransform: 'uppercase' as const,
	color: colors.textMuted,
}

export const pageTitleCss = {
	margin: 0,
	fontSize: typography.fontSize.xl,
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
}

export const pageDescriptionCss = {
	margin: 0,
	color: colors.textMuted,
}

export const cardCss = {
	padding: spacing.lg,
	borderRadius: radius.lg,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.surface,
	boxShadow: shadows.sm,
	display: 'grid',
	gap: spacing.md,
}

export const insetCardCss = {
	padding: spacing.md,
	borderRadius: radius.md,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.background,
	display: 'grid',
	gap: spacing.xs,
}

export const cardTitleCss = {
	margin: 0,
	fontSize: typography.fontSize.lg,
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
}

export const sectionTitleCss = {
	margin: 0,
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
}

export const descriptionCss = {
	margin: 0,
	color: colors.textMuted,
}

export const fieldCss = {
	display: 'grid',
	gap: spacing.xs,
}

export const fieldLabelCss = {
	color: colors.text,
	fontWeight: typography.fontWeight.medium,
	fontSize: typography.fontSize.sm,
}

export const inputCss = {
	width: '100%',
	padding: spacing.sm,
	borderRadius: radius.md,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.background,
	color: colors.text,
	fontSize: typography.fontSize.base,
	fontFamily: typography.fontFamily,
	boxSizing: 'border-box' as const,
}

export const textareaCss = {
	...inputCss,
	resize: 'vertical' as const,
	minHeight: '7rem',
}

export const listCss = {
	margin: 0,
	paddingLeft: spacing.lg,
	display: 'grid',
	gap: spacing.xs,
	color: colors.text,
}

export const detailGridCss = {
	display: 'grid',
	gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))',
	gap: spacing.md,
}

export const detailItemCss = {
	display: 'grid',
	gap: spacing.xs,
	alignContent: 'start',
}

export const detailLabelCss = {
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.medium,
	color: colors.textMuted,
}

export const detailValueCss = {
	color: colors.text,
}

export const primaryLinkCss = {
	color: colors.primaryText,
	fontWeight: typography.fontWeight.medium,
	textDecoration: 'none',
	'&:hover': {
		textDecoration: 'underline',
	},
}

export const mutedLinkCss = {
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
	textDecoration: 'none',
	'&:hover': {
		textDecoration: 'underline',
	},
}
