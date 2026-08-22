/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { type Handle, css } from 'remix/ui'
import {
	colors,
	radius,
	shadows,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { hoverMq } from '#universal/styles/style-primitives.ts'

export const FORK_OUTDATED_COPY_TOOLTIP = 'Click to copy an update prompt'
export const FORK_OUTDATED_COPIED_TOOLTIP = 'Copied'

type ForkOutdatedCopyButtonProps = {
	prompt: string
	testId: string
}

/**
 * Yellow pill that stands in for Installed/Forked when a community listing
 * has been republished ahead of this fork. Frames render this as static HTML;
 * the hydrated app copies `data-copy-text` on click and swaps the tooltip.
 */
export function ForkOutdatedCopyButton(
	handle: Handle<ForkOutdatedCopyButtonProps>,
) {
	return () => (
		<button
			type="button"
			data-testid={handle.props.testId}
			data-fork-outdated-copy=""
			data-copy-text={handle.props.prompt}
			mix={css(forkOutdatedCopyButtonCss)}
		>
			Fork outdated
			<span role="tooltip">{FORK_OUTDATED_COPY_TOOLTIP}</span>
		</button>
	)
}

/*
 * CSS hover/focus tooltip (same grammar as onboarding Copy prompt): a
 * top-layer popover would steal pointer events from neighboring pills.
 * `pointer-events: none` keeps the tip from becoming a hover target.
 * `z-index` lifts the control above a listing card's stretched name-link
 * overlay so the click hits the button instead of the card.
 */
const forkOutdatedCopyButtonCss = {
	position: 'relative' as const,
	zIndex: 1,
	flex: 'none',
	appearance: 'none' as const,
	margin: 0,
	border: 'none',
	fontFamily: 'inherit',
	fontSize: '0.78rem',
	fontWeight: 650,
	lineHeight: 1.2,
	color: 'oklch(0.48 0.12 85)',
	backgroundColor: 'oklch(0.88 0.12 95 / 0.92)',
	borderRadius: '999px',
	padding: '0.15rem 0.6rem',
	whiteSpace: 'nowrap' as const,
	cursor: 'pointer',
	[hoverMq]: {
		'&:hover': {
			backgroundColor: 'oklch(0.84 0.13 95)',
		},
	},
	'&:focus-visible': {
		outline: `2px solid oklch(0.7 0.14 90)`,
		outlineOffset: '2px',
	},
	'& [role="tooltip"]': {
		position: 'absolute' as const,
		left: '50%',
		bottom: 'calc(100% + 0.45rem)',
		transform: 'translateX(-50%)',
		width: 'max-content',
		maxWidth: 'min(16rem, calc(100vw - 2rem))',
		padding: `${spacing.xs} ${spacing.sm}`,
		borderRadius: radius.md,
		backgroundColor: colors.surface,
		color: colors.text,
		fontSize: typography.fontSize.sm,
		fontWeight: 400,
		lineHeight: 1.4,
		textAlign: 'left' as const,
		boxShadow: shadows.md,
		border: `1px solid ${colors.border}`,
		pointerEvents: 'none' as const,
		opacity: 0,
		visibility: 'hidden' as const,
		zIndex: 2,
		whiteSpace: 'normal' as const,
	},
	'& [role="tooltip"]::after': {
		content: '""',
		position: 'absolute' as const,
		top: '100%',
		left: '50%',
		transform: 'translateX(-50%)',
		border: '6px solid transparent',
		borderTopColor: colors.surface,
	},
	[`${hoverMq} &:hover [role="tooltip"]`]: {
		opacity: 1,
		visibility: 'visible' as const,
	},
	'&:focus-visible [role="tooltip"]': {
		opacity: 1,
		visibility: 'visible' as const,
	},
}
