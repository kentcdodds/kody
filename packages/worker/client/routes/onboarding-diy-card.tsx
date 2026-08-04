import { type Handle, css } from 'remix/ui'
import * as popover from 'remix/ui/popover'
import { writeClipboardText } from '#client/clipboard.ts'
import { on } from '#client/event-mixin.ts'
import { colors, typography } from '#client/styles/tokens.ts'
import {
	starterCardCss,
	starterGhostButtonCss,
	starterTooltipSurfaceCss,
} from '#client/routes/onboarding-starter-card.tsx'

type OnboardingDiyCardProps = {
	setupPrompt: string
}

const copyPromptTooltip =
	'Copies a prompt you can paste into your agent to explore what Kody can do and build something custom.'

/**
 * Trailing onboarding card, the prototype's `.starter-diy`: breaks the grid
 * with a dashed border and a soft green tint so "no package" reads as a real
 * option — copy the open-ended setup prompt instead of installing a starter.
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
		<li mix={css(diyCardCss)} data-testid="onboarding-diy-card">
			<div mix={css(diyBodyCss)}>
				<em mix={css(diyEyebrowCss)}>Build it yourself</em>
				<strong mix={css(diyTitleCss)}>Choose your own adventure</strong>
				<span mix={css(diyDescriptionCss)}>
					Skip the starters and ask your agent what Kody can do — connect an
					integration, explore, and build something custom.
				</span>
			</div>
			<popover.Context>
				<button
					type="button"
					aria-describedby="onboarding-diy-prompt-tip"
					disabled={!handle.props.setupPrompt}
					mix={[
						css(starterGhostButtonCss),
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
						css(starterTooltipSurfaceCss),
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
		</li>
	)
}

const diyCardCss = {
	...starterCardCss,
	borderStyle: 'dashed' as const,
	backgroundColor: `oklch(from ${colors.primary} l c h / 0.07)`,
}

const diyBodyCss = {
	flex: 1,
	display: 'flex',
	flexDirection: 'column' as const,
	alignItems: 'center',
	gap: '0.45rem',
}

const diyEyebrowCss = {
	font: `700 0.72rem/1 ${typography.fontFamilyDisplay}`,
	fontStyle: 'normal',
	textTransform: 'uppercase' as const,
	letterSpacing: '0.09em',
	color: colors.primaryText,
}

const diyTitleCss = {
	color: colors.text,
	fontWeight: 650,
	fontSize: '0.98rem',
}

const diyDescriptionCss = {
	color: colors.textMuted,
	fontSize: '0.88rem',
	lineHeight: 1.45,
}
