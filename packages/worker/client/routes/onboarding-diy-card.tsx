import { type Handle, css } from 'remix/ui'
import { writeClipboardText } from '#client/clipboard.ts'
import { on } from '#client/event-mixin.ts'
import { colors, typography } from '#universal/styles/tokens.ts'
import {
	starterCardCss,
	starterCopyPromptTooltipCss,
	starterGhostButtonCss,
	starterRowCss,
} from '#client/routes/onboarding-starter-card.tsx'

type OnboardingDiyCardProps = {
	setupPrompt: string
	/** `row` matches the compact "Advanced" starter list. */
	variant?: 'card' | 'row'
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

	return () => {
		const isRow = handle.props.variant === 'row'
		return (
			<li
				mix={css(isRow ? diyRowCss : diyCardCss)}
				data-testid="onboarding-diy-card"
			>
				<div mix={css(isRow ? diyRowBodyCss : diyBodyCss)}>
					<em mix={css(diyEyebrowCss)}>Build it yourself</em>
					<strong mix={css(diyTitleCss)}>Choose your own adventure</strong>
					<span mix={css(diyDescriptionCss)}>
						Skip the starters and ask your agent what Kody can do — connect an
						integration, explore, and build something custom.
					</span>
				</div>
				<button
					type="button"
					aria-describedby="onboarding-diy-prompt-tip"
					disabled={!handle.props.setupPrompt}
					mix={[
						css(isRow ? diyRowCopyButtonCss : diyCopyButtonCss),
						on('click', () => void copyPrompt()),
					]}
					data-testid="onboarding-diy-copy"
				>
					{copyState === 'copied'
						? 'Copied'
						: copyState === 'error'
							? 'Copy failed'
							: 'Copy prompt'}
					<span id="onboarding-diy-prompt-tip" role="tooltip">
						{copyPromptTooltip}
					</span>
				</button>
			</li>
		)
	}
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

const diyCopyButtonCss = {
	...starterGhostButtonCss,
	...starterCopyPromptTooltipCss,
}

const diyRowCss = {
	...starterRowCss,
	borderStyle: 'dashed' as const,
	backgroundColor: `oklch(from ${colors.primary} l c h / 0.07)`,
}

const diyRowBodyCss = {
	flex: 1,
	display: 'grid',
	gap: '0.1rem',
	minWidth: 'min(16rem, 100%)',
	textAlign: 'left' as const,
	justifyItems: 'start',
}

const diyRowCopyButtonCss = {
	...starterGhostButtonCss,
	...starterCopyPromptTooltipCss,
	width: 'auto',
	flex: 'none',
	fontSize: '0.9rem',
}
