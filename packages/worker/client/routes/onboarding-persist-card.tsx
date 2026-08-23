import { type Handle, css } from 'remix/ui'
import { writeClipboardText } from '#client/clipboard.ts'
import { on } from '#client/event-mixin.ts'
import { colors, typography } from '#universal/styles/tokens.ts'
import {
	getAccentCalloutCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'

type OnboardingPersistCardProps = {
	persistPrompt: string
	connectedServerLabel: string | null
}

/**
 * Step 3 lead: copy the ad hoc → persist prompt after the person connected
 * (or skipped) a featured MCP server.
 */
export function OnboardingPersistCard(
	handle: Handle<OnboardingPersistCardProps>,
) {
	let copyState: 'idle' | 'copied' | 'error' = 'idle'
	let copyResetTimerId: ReturnType<typeof setTimeout> | null = null

	async function copyPrompt() {
		try {
			await writeClipboardText(handle.props.persistPrompt)
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
		const connectedLabel = handle.props.connectedServerLabel
		return (
			<div mix={css(cardCss)} data-testid="onboarding-persist-card">
				<p mix={css(kickerCss)}>Paste this next</p>
				<h3 mix={css(titleCss)}>
					{connectedLabel
						? `Ask your agent to use ${connectedLabel}, then save the result`
						: 'Ask your agent to try something, then save the result'}
				</h3>
				<p mix={css(copyCss)}>
					The prompt tells your agent to run one ad hoc request
					{connectedLabel ? ` against ${connectedLabel}` : ''}, show you the
					result, and persist that working code as a package you own.
				</p>
				<button
					type="button"
					disabled={!handle.props.persistPrompt}
					mix={[css(copyButtonCss), on('click', () => void copyPrompt())]}
					data-testid="onboarding-persist-copy"
				>
					{copyState === 'copied'
						? 'Copied'
						: copyState === 'error'
							? 'Copy failed'
							: 'Copy prompt'}
				</button>
			</div>
		)
	}
}

const cardCss = {
	...getAccentCalloutCss({ accentColor: colors.primary }),
	display: 'grid',
	gap: '0.7rem',
	padding: '1.2rem 1.35rem',
	borderLeftWidth: '6px',
	backgroundColor: `oklch(from ${colors.primary} l c h / 0.12)`,
}

const kickerCss = {
	margin: 0,
	font: `700 0.78rem/1 ${typography.fontFamilyDisplay}`,
	letterSpacing: '0.09em',
	textTransform: 'uppercase' as const,
	color: colors.primaryText,
}

const titleCss = {
	margin: 0,
	font: `720 1.2rem/1.25 ${typography.fontFamilyDisplay}`,
	letterSpacing: '-0.018em',
	color: colors.text,
}

const copyCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.95rem',
	lineHeight: 1.55,
	maxWidth: '62ch',
}

const copyButtonCss = {
	...getPillButtonCss(),
	width: 'fit-content',
	marginTop: '0.2rem',
}
