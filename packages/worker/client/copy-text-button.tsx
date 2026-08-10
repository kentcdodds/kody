import { type Handle, css } from 'remix/ui'
import { writeClipboardText } from '#client/clipboard.ts'
import { on } from '#client/event-mixin.ts'
import {
	getChipButtonCss,
	getGhostButtonCss,
	getPillButtonCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	getSwapLabelCss,
	mergeCss,
} from '#universal/styles/style-primitives.ts'

type CopyTextButtonProps = {
	value: string
	idleLabel?: string
	/**
	 * `pill` is the redesign's display-face pill (prompt-block copy);
	 * `ghost` its bordered transparent sibling (snippet copy); `chip` the
	 * value-sized control that rides along with an id.
	 */
	variant?: 'primary' | 'secondary' | 'pill' | 'ghost' | 'chip'
	/**
	 * `sm` is the in-page action size the account and admin areas use.
	 * Applies to the `pill` and `ghost` variants.
	 */
	size?: 'md' | 'sm'
	/**
	 * Names the button when its own label cannot. A metadata band carries one
	 * copy button per id, and a screen reader's button list of six identical
	 * "Copy" entries says nothing about which id each one takes.
	 */
	ariaLabel?: string
}

type CopyState = 'idle' | 'copied' | 'error'

const visuallyHiddenCss = {
	position: 'absolute' as const,
	width: '1px',
	height: '1px',
	padding: 0,
	margin: '-1px',
	overflow: 'hidden',
	clip: 'rect(0 0 0 0)',
	whiteSpace: 'nowrap' as const,
	border: 0,
}

// css() is static after hydration, so all variants are prebuilt and the
// dynamic state flows through data attributes on the labels, never through
// swapped style objects.
const primaryCopyButtonCss = mergeCss(getPrimaryButtonCss(), getSwapLabelCss())
const secondaryCopyButtonCss = mergeCss(
	getSecondaryButtonCss(),
	getSwapLabelCss(),
)
const pillCopyButtonCss = mergeCss(getPillButtonCss(), getSwapLabelCss())
const ghostCopyButtonCss = mergeCss(getGhostButtonCss(), getSwapLabelCss())
const chipCopyButtonCss = mergeCss(getChipButtonCss(), getSwapLabelCss())

const smallPillCopyButtonCss = mergeCss(
	getPillButtonCss({ size: 'sm' }),
	getSwapLabelCss(),
)
const smallGhostCopyButtonCss = mergeCss(
	getGhostButtonCss({ size: 'sm' }),
	getSwapLabelCss(),
)

const copyButtonCssByVariant = {
	primary: primaryCopyButtonCss,
	secondary: secondaryCopyButtonCss,
	pill: pillCopyButtonCss,
	ghost: ghostCopyButtonCss,
	chip: chipCopyButtonCss,
} as const

const smallCopyButtonCssByVariant = {
	pill: smallPillCopyButtonCss,
	ghost: smallGhostCopyButtonCss,
} as const

function getCopyButtonCss(
	variant: NonNullable<CopyTextButtonProps['variant']>,
	size: CopyTextButtonProps['size'],
) {
	if (size === 'sm' && (variant === 'pill' || variant === 'ghost')) {
		return smallCopyButtonCssByVariant[variant]
	}
	return copyButtonCssByVariant[variant]
}

/**
 * Button that copies `value` to the clipboard and shows transient
 * "Copied" / "Copy failed" feedback before returning to the idle label.
 * All three labels stay grid-stacked in the same cell so the button never
 * changes size when the label swaps — the swap is a blur crossfade instead.
 */
export function CopyTextButton(handle: Handle<CopyTextButtonProps>) {
	let copyState: CopyState = 'idle'
	let resetTimerId: ReturnType<typeof setTimeout> | null = null

	async function copyValue() {
		try {
			await writeClipboardText(handle.props.value)
			copyState = 'copied'
		} catch {
			copyState = 'error'
		}
		handle.update()
		if (resetTimerId != null) clearTimeout(resetTimerId)
		resetTimerId = setTimeout(() => {
			resetTimerId = null
			if (handle.signal.aborted) return
			copyState = 'idle'
			handle.update()
		}, 2000)
	}

	function renderLabel(state: CopyState, text: string) {
		const active = copyState === state
		return (
			<span
				data-swap-label
				data-active={active ? 'true' : undefined}
				aria-hidden={active ? undefined : 'true'}
			>
				{text}
			</span>
		)
	}

	return () => (
		<button
			type="button"
			aria-label={handle.props.ariaLabel}
			// The result is announced by the live region below rather than by the
			// button's own name: `aria-label` overrides the label text, so a named
			// button would keep reading "Copy package id" after it had copied.
			aria-describedby={`${handle.id}-copy-status`}
			mix={[
				css(
					getCopyButtonCss(
						handle.props.variant ?? 'primary',
						handle.props.size,
					),
				),
				on('click', () => void copyValue()),
			]}
		>
			{renderLabel('idle', handle.props.idleLabel ?? 'Copy')}
			{renderLabel('copied', 'Copied')}
			{renderLabel('error', 'Copy failed')}
			<span
				id={`${handle.id}-copy-status`}
				role="status"
				mix={css(visuallyHiddenCss)}
			>
				{copyState === 'copied'
					? 'Copied'
					: copyState === 'error'
						? 'Copy failed'
						: ''}
			</span>
		</button>
	)
}
