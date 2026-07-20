import { type Handle, css } from 'remix/ui'
import * as popover from 'remix/ui/popover'
import { writeClipboardText } from '#client/clipboard.ts'
import { on } from '#client/event-mixin.ts'
import {
	colors,
	radius,
	shadows,
	spacing,
	typography,
} from '#client/styles/tokens.ts'
import { getSecondaryButtonCss } from '#client/styles/style-primitives.ts'
import {
	starterCardCss,
	starterCardItemCss,
} from '#client/routes/onboarding-starter-card.tsx'

type OnboardingDiyCardProps = {
	setupPrompt: string
}

const copyPromptTooltip =
	'Copies a prompt you can paste into your agent to explore what Kody can do and build something custom.'

/**
 * Trailing onboarding card: copy the open-ended setup prompt instead of
 * installing a starter package ("choose your own adventure").
 */
export function OnboardingDiyCard(handle: Handle<OnboardingDiyCardProps>) {
	let copyState: 'idle' | 'copied' | 'error' = 'idle'
	let copyResetTimerId: ReturnType<typeof setTimeout> | null = null
	let tooltipOpen = false

	function openTooltip() {
		tooltipOpen = true
		handle.update()
	}

	function closeTooltip() {
		tooltipOpen = false
		handle.update()
	}

	async function copyPrompt() {
		try {
			await writeClipboardText(handle.props.setupPrompt)
			copyState = 'copied'
		} catch {
			copyState = 'error'
		}
		handle.update()
		if (copyResetTimerId != null) clearTimeout(copyResetTimerId)
		copyResetTimerId = setTimeout(() => {
			copyResetTimerId = null
			if (handle.signal.aborted) return
			copyState = 'idle'
			handle.update()
		}, 2000)
	}

	return () => (
		<li mix={css(starterCardItemCss)}>
			<div
				mix={css({ ...starterCardCss, ...diyCardAccentCss })}
				data-testid="onboarding-diy-card"
			>
				<div mix={css(diyBodyCss)}>
					<span mix={css(diyEyebrowCss)}>Build it yourself</span>
					<span mix={css(diyTitleCss)}>Choose your own adventure</span>
					<span mix={css(diyDescriptionCss)}>
						Skip the starters and ask your agent what Kody can do — connect an
						integration, explore, and build something custom.
					</span>
				</div>
				<div mix={css(diyActionsCss)}>
					<popover.Context>
						<button
							type="button"
							aria-describedby="onboarding-diy-prompt-tip"
							disabled={!handle.props.setupPrompt}
							mix={[
								css(diyButtonCss),
								popover.anchor({ placement: 'top' }),
								popover.focusOnHide(),
								on('click', () => void copyPrompt()),
								on('pointerenter', openTooltip),
								on('pointerleave', closeTooltip),
								on('focus', openTooltip),
								on('blur', closeTooltip),
							]}
							data-testid="onboarding-diy-copy"
						>
							{copyState === 'copied'
								? 'Copied'
								: copyState === 'error'
									? 'Copy failed'
									: 'Copy prompt'}
						</button>
						<div
							id="onboarding-diy-prompt-tip"
							role="tooltip"
							mix={[
								css(tooltipSurfaceCss),
								popover.surface({
									open: tooltipOpen,
									closeOnAnchorClick: false,
									onHide() {
										closeTooltip()
									},
								}),
							]}
						>
							{copyPromptTooltip}
						</div>
					</popover.Context>
				</div>
			</div>
		</li>
	)
}

const diyCardAccentCss = {
	borderStyle: 'dashed' as const,
	backgroundColor: colors.primarySoftest,
}

const diyBodyCss = {
	display: 'flex',
	flexDirection: 'column' as const,
	alignItems: 'center',
	gap: spacing.xs,
	flex: 1,
	textAlign: 'center' as const,
}

const diyEyebrowCss = {
	fontSize: typography.fontSize.xs,
	fontWeight: typography.fontWeight.medium,
	color: colors.primary,
	textTransform: 'uppercase' as const,
	letterSpacing: '0.04em',
}

const diyTitleCss = {
	fontWeight: typography.fontWeight.semibold,
	color: colors.primaryText,
	fontSize: typography.fontSize.sm,
}

const diyDescriptionCss = {
	color: colors.textMuted,
	fontSize: typography.fontSize.xs,
	lineHeight: 1.4,
}

const diyActionsCss = {
	marginTop: 'auto',
	display: 'flex',
	justifyContent: 'center',
}

const diyButtonCss = {
	...getSecondaryButtonCss(),
	width: '100%',
	justifyContent: 'center',
}

const tooltipSurfaceCss = {
	maxWidth: '16rem',
	padding: `${spacing.xs} ${spacing.sm}`,
	borderRadius: radius.md,
	backgroundColor: colors.surface,
	color: colors.text,
	fontSize: typography.fontSize.sm,
	lineHeight: 1.4,
	boxShadow: shadows.md,
	border: `1px solid ${colors.border}`,
}
