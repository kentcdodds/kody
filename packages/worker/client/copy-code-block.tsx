import { type Handle, css } from 'remix/ui'
import { writeClipboardText } from '#client/clipboard.ts'
import { on } from '#client/event-mixin.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { renderHighlightedCode } from '#client/syntax-highlight.tsx'

export type CopyCodeBlockProps = { code: string; lang?: string | null }

/**
 * A highlighted `<pre>` code block with a copy button, for first-party
 * markdown surfaces (guides) whose snippets exist to be pasted into an
 * agent or terminal. Only the button is interactive.
 */
export function CopyCodeBlock(handle: Handle<CopyCodeBlockProps>) {
	let copyState: 'idle' | 'copied' | 'error' = 'idle'
	let copyResetTimerId: ReturnType<typeof setTimeout> | null = null

	async function copy() {
		try {
			await writeClipboardText(handle.props.code)
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
		<div mix={css(wrapperCss)}>
			{renderHighlightedCode(handle.props.code, handle.props.lang)}
			<button
				type="button"
				aria-label="Copy code to clipboard"
				mix={[css(copyButtonCss), on('click', () => void copy())]}
			>
				{copyState === 'copied'
					? 'Copied'
					: copyState === 'error'
						? 'Copy failed'
						: 'Copy'}
			</button>
		</div>
	)
}

const wrapperCss = {
	position: 'relative' as const,
	'& pre': {
		margin: 0,
	},
}

// Always visible (dimmed at rest): hover-reveal would hide the affordance on
// touch devices, and guide snippets exist to be copied.
const copyButtonCss = {
	position: 'absolute' as const,
	top: spacing.xs,
	right: spacing.xs,
	padding: `0.25rem ${spacing.sm}`,
	borderRadius: radius.md,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.surface,
	color: colors.textMuted,
	fontSize: typography.fontSize.xs,
	fontWeight: typography.fontWeight.semibold,
	cursor: 'pointer',
	opacity: 0.75,
	transition: 'opacity 120ms ease, color 120ms ease',
	'&:hover': {
		opacity: 1,
		color: colors.text,
	},
}
