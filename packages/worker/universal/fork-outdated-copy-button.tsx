/** @jsxImportSource remix/ui */
/** @jsxRuntime automatic */
import { type Handle, css } from 'remix/ui'
import { communityStatusPillBoxCss } from '#universal/community-status-pill.ts'
import { hoverMq, mergeCss } from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	shadows,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'

export const COPY_PROMPT_SELECTOR = '[data-copy-prompt]'
export const FORK_OUTDATED_COPY_TOOLTIP = 'Click to copy an update prompt'
export const FORKED_COPY_TOOLTIP =
	'Click to copy a prompt to finish adapting this fork'
export const COPY_PROMPT_COPIED_TOOLTIP = 'Copied'

export const FORK_AHEAD_TOOLTIP =
	'Review the listing snapshot this fork is ahead of'

type CopyPromptPillInput = {
	label: string
	prompt: string
	testId: string
	tooltip: string
	tone: 'badge' | 'outdated'
	href?: string | null
}

type ForkOutdatedCopyButtonProps = {
	prompt: string
	testId: string
	href?: string | null
}

type ForkAheadLinkProps = {
	href: string
	testId: string
}

/**
 * Static HTML copy pill. Frames render it without hydration; the app copies
 * `data-copy-text` on click and swaps the tooltip.
 */
export function renderCopyPromptPill(input: CopyPromptPillInput) {
	const tooltipId = `${input.testId}-tooltip`
	const copyAttrs = {
		'data-testid': input.testId,
		'data-copy-prompt': '',
		'data-copy-text': input.prompt,
		'data-copy-tooltip': input.tooltip,
		'aria-describedby': tooltipId,
		...(input.tone === 'outdated' ? { 'data-fork-outdated-copy': '' } : {}),
	}
	const copyMix = css(
		input.tone === 'outdated'
			? forkOutdatedCopyButtonCss
			: badgeCopyPromptButtonCss,
	)
	const children = (
		<>
			{input.label}
			<span id={tooltipId} role="tooltip" aria-hidden="true">
				{input.tooltip}
			</span>
		</>
	)
	if (input.href) {
		return (
			<a href={input.href} {...copyAttrs} mix={copyMix}>
				{children}
			</a>
		)
	}
	return (
		<button type="button" {...copyAttrs} mix={copyMix}>
			{children}
		</button>
	)
}

/**
 * Yellow pill that stands in for Installed/Forked when a community listing
 * has been republished ahead of this fork.
 */
export function ForkOutdatedCopyButton(
	handle: Handle<ForkOutdatedCopyButtonProps>,
) {
	return () =>
		renderCopyPromptPill({
			label: 'Fork outdated',
			prompt: handle.props.prompt,
			testId: handle.props.testId,
			tooltip: FORK_OUTDATED_COPY_TOOLTIP,
			tone: 'outdated',
			href: handle.props.href,
		})
}

/**
 * Calm informational pill when the listing pin is an ancestor of the fork
 * tip. Links to the listing files at that pin; no absorb-prompt action.
 */
export function ForkAheadLink(handle: Handle<ForkAheadLinkProps>) {
	return () => (
		<a
			href={handle.props.href}
			data-testid={handle.props.testId}
			title={FORK_AHEAD_TOOLTIP}
			mix={css(forkAheadLinkCss)}
		>
			Fork ahead
		</a>
	)
}

export function renderForkAheadPill(input: { href: string; testId: string }) {
	return (
		<a
			href={input.href}
			data-testid={input.testId}
			title={FORK_AHEAD_TOOLTIP}
			mix={css(forkAheadLinkCss)}
		>
			Fork ahead
		</a>
	)
}

const copyPromptTooltipCss = {
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
	[hoverMq]: {
		'&:hover [role="tooltip"]': {
			opacity: 1,
			visibility: 'visible' as const,
		},
	},
	'&:focus-visible [role="tooltip"]': {
		opacity: 1,
		visibility: 'visible' as const,
	},
	'&[data-tooltip-dismissed] [role="tooltip"]': {
		opacity: 0,
		visibility: 'hidden' as const,
	},
}

const copyPromptButtonBaseCss = {
	...communityStatusPillBoxCss,
	position: 'relative' as const,
	zIndex: 1,
	appearance: 'none' as const,
	cursor: 'pointer',
	textDecoration: 'none',
	...copyPromptTooltipCss,
}

/*
 * CSS hover/focus tooltip (same grammar as onboarding Copy prompt): a
 * top-layer popover would steal pointer events from neighboring pills.
 * `pointer-events: none` keeps the tip from becoming a hover target.
 * `z-index` lifts the control above a listing card's stretched name-link
 * overlay so the click hits the button instead of the card.
 */
const forkOutdatedCopyButtonCss = mergeCss(copyPromptButtonBaseCss, {
	color: 'oklch(0.48 0.12 85)',
	backgroundColor: 'oklch(0.88 0.12 95 / 0.92)',
	[hoverMq]: {
		'&:hover': {
			backgroundColor: 'oklch(0.84 0.13 95)',
		},
	},
	'&:focus-visible': {
		outline: `2px solid oklch(0.7 0.14 90)`,
		outlineOffset: '2px',
	},
})

const badgeCopyPromptButtonCss = mergeCss(copyPromptButtonBaseCss, {
	color: colors.primaryText,
	backgroundColor: `oklch(from ${colors.primary} l c h / 0.13)`,
	[hoverMq]: {
		'&:hover': {
			backgroundColor: `oklch(from ${colors.primary} l c h / 0.2)`,
		},
	},
	'&:focus-visible': {
		outline: `2px solid ${colors.primary}`,
		outlineOffset: '2px',
	},
})

const forkAheadLinkCss = mergeCss(communityStatusPillBoxCss, {
	position: 'relative' as const,
	zIndex: 1,
	textDecoration: 'none',
	color: colors.textMuted,
	backgroundColor: colors.surface,
	border: `1px solid ${colors.border}`,
	[hoverMq]: {
		'&:hover': {
			color: colors.text,
			borderColor: colors.textMuted,
		},
	},
	'&:focus-visible': {
		outline: `2px solid ${colors.border}`,
		outlineOffset: '2px',
	},
})
